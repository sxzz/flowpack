import {
  Evaluator,
  data as expressionData,
  Lexer,
  Parser,
} from '@actions/expressions'
import {
  Binary,
  ContextAccess,
  FunctionCall,
  Grouping,
  IndexAccess,
  Literal,
  Logical,
  Star,
  Unary,
  type Expr,
} from '@actions/expressions/ast'
import { truthy } from '@actions/expressions/result'
import type { ExpressionData } from '@actions/expressions/data/index'

export const EXPRESSION_CONTEXTS: string[] = [
  'env',
  'github',
  'inputs',
  'job',
  'matrix',
  'needs',
  'runner',
  'secrets',
  'steps',
  'strategy',
  'vars',
]

export type StaticIfValue = boolean | ''

export interface StaticExpression {
  data: ExpressionData
  text: string
  truthy: boolean
  value: unknown
}

export function parseExpression(expression: string): Expr {
  return new Parser(
    new Lexer(expression).lex().tokens,
    EXPRESSION_CONTEXTS,
    [],
  ).parse()
}

export function expressionBody(value: string): string | undefined {
  if (!value.startsWith('${{') || !value.endsWith('}}')) {
    return
  }
  return value.slice(3, -2).trim()
}

export function staticExpression(
  expr: Expr,
  values: Record<string, unknown> = {},
): StaticExpression | undefined {
  const evaluated = evaluateStaticExpression(expr, values)
  if (evaluated) {
    return evaluated
  }
  if (expr instanceof Logical) {
    return simplifyLogicalExpression(expr, values, (item) =>
      printExpression(item, values),
    ).static
  }
  return
}

export function simplifyLogicalExpression(
  expr: Logical,
  values: Record<string, unknown>,
  printExpression: (expr: Expr) => string,
): { static?: StaticExpression; text: string } {
  const op = expr.operator.lexeme
  const pending: string[] = []
  let lastStatic: StaticExpression | undefined

  for (const arg of expr.args) {
    const staticArg = staticExpression(arg, values)
    const text = staticArg?.text ?? printExpression(arg)
    if (!staticArg) {
      pending.push(text)
      continue
    }

    lastStatic = staticArg
    if (pending.length === 0) {
      if (op === '&&' && !staticArg.truthy) {
        return { static: staticArg, text }
      }
      if (op === '&&' && staticArg.truthy) {
        continue
      }
      if (op === '||' && staticArg.truthy) {
        return { static: staticArg, text }
      }
      if (op === '||' && !staticArg.truthy) {
        continue
      }
    }

    pending.push(text)
  }

  if (pending.length === 0 && lastStatic) {
    return { static: lastStatic, text: lastStatic.text }
  }
  if (pending.length === 1) {
    return { text: pending[0]! }
  }
  return { text: pending.join(` ${op} `) }
}

export function staticIfExpression(
  expression: string,
): StaticIfValue | undefined {
  try {
    const value = staticExpression(parseExpression(expression))
    if (value?.value === true) {
      return true
    }
    if (value?.value === false) {
      return false
    }
    if (value?.value === '') {
      return ''
    }
    return
  } catch {
    return
  }
}

export function printExpression(
  expr: Expr,
  values: Record<string, unknown>,
): string {
  const staticValue = staticExpression(expr, values)
  if (staticValue) {
    return staticValue.text
  }
  if (expr instanceof Binary) {
    return `${printExpression(expr.left, values)} ${expr.operator.lexeme} ${printExpression(expr.right, values)}`
  }
  if (expr instanceof ContextAccess) {
    return expr.name.lexeme
  }
  if (expr instanceof FunctionCall) {
    return printFunctionExpression(expr, values)
  }
  if (expr instanceof Grouping) {
    return `(${printExpression(expr.group, values)})`
  }
  if (expr instanceof IndexAccess) {
    const replacement = replacementForIndexAccess(expr, values)
    if (replacement !== undefined) {
      return replacement
    }
    return printIndexAccess(expr, values)
  }
  if (expr instanceof Literal) {
    return expr.token.lexeme
  }
  if (expr instanceof Logical) {
    return simplifyLogicalExpression(expr, values, (item) =>
      printExpression(item, values),
    ).text
  }
  if (expr instanceof Star) {
    return '*'
  }
  if (expr instanceof Unary) {
    return `${expr.operator.lexeme}${printExpression(expr.expr, values)}`
  }
  throw new Error('Unsupported expression node')
}

export function literalString(expr: Literal): string {
  if (typeof expr.token.value === 'string') {
    return expr.token.value
  }
  const literal = expr.literal as { value?: unknown }
  return typeof literal.value === 'string' ? literal.value : ''
}

export function valueForIndexAccess(
  expr: Expr,
  values: Record<string, unknown>,
): unknown {
  if (!(expr instanceof IndexAccess)) {
    return
  }
  return hasValueForIndexAccess(expr, values)
    ? values[indexAccessKey(expr)!]
    : undefined
}

export function quoteExpressionString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function valueLiteral(value: unknown): string {
  if (value === undefined || value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    return quoteExpressionString(value)
  }
  return `fromJson(${quoteExpressionString(JSON.stringify(value))})`
}

function evaluateStaticExpression(
  expr: Expr,
  values: Record<string, unknown>,
): StaticExpression | undefined {
  if (!canEvaluateExpression(expr, values)) {
    return
  }
  try {
    const data = new Evaluator(expr, expressionContext(values)).evaluate()
    return {
      data,
      text: valueLiteral(dataValue(data)),
      truthy: truthy(data),
      value: dataValue(data),
    }
  } catch {}
}

function hasValueForIndexAccess(
  expr: IndexAccess,
  values: Record<string, unknown>,
): boolean {
  const key = indexAccessKey(expr)
  return key !== undefined && Object.hasOwn(values, key)
}

function indexAccessKey(expr: IndexAccess): string | undefined {
  if (
    !(expr.expr instanceof ContextAccess) ||
    !(expr.index instanceof Literal)
  ) {
    return
  }
  const root = expr.expr.name.lexeme
  if (root !== 'inputs' && root !== 'secrets') {
    return
  }
  const name = literalString(expr.index)
  return name ? `${root}.${name}` : undefined
}

function canEvaluateExpression(
  expr: Expr,
  values: Record<string, unknown>,
): boolean {
  if (expr instanceof Binary) {
    return (
      canEvaluateExpression(expr.left, values) &&
      canEvaluateExpression(expr.right, values)
    )
  }
  if (expr instanceof ContextAccess) {
    return Object.hasOwn(values, expr.name.lexeme)
  }
  if (expr instanceof FunctionCall) {
    return expr.args.every((arg) => canEvaluateExpression(arg, values))
  }
  if (expr instanceof Grouping) {
    return canEvaluateExpression(expr.group, values)
  }
  if (expr instanceof IndexAccess) {
    return (
      hasStaticValueForIndexAccess(expr, values) ||
      (canEvaluateExpression(expr.expr, values) &&
        canEvaluateExpression(expr.index, values))
    )
  }
  if (expr instanceof Literal) {
    return true
  }
  if (expr instanceof Logical) {
    return expr.args.every((arg) => canEvaluateExpression(arg, values))
  }
  if (expr instanceof Star) {
    return false
  }
  if (expr instanceof Unary) {
    return canEvaluateExpression(expr.expr, values)
  }
  return false
}

function expressionContext(
  values: Record<string, unknown>,
): expressionData.Dictionary {
  const roots = new Map<string, Map<string, unknown>>()
  const pairs: { key: string; value: ExpressionData }[] = []
  for (const [key, value] of Object.entries(values)) {
    const [root, ...rest] = key.split('.')
    if (!root) {
      continue
    }
    if (rest.length === 0) {
      pairs.push({ key: root, value: toExpressionData(value) })
      continue
    }
    const name = rest.join('.')
    const entries = roots.get(root) ?? new Map<string, unknown>()
    entries.set(name, value)
    roots.set(root, entries)
  }
  for (const [root, entries] of roots) {
    pairs.push({
      key: root,
      value: new expressionData.Dictionary(
        ...[...entries].map(([key, value]) => ({
          key,
          value: toExpressionData(value),
        })),
      ),
    })
  }
  return new expressionData.Dictionary(...pairs)
}

function toExpressionData(value: unknown): ExpressionData {
  if (value === undefined || value === null) {
    return new expressionData.Null()
  }
  if (typeof value === 'boolean') {
    return new expressionData.BooleanData(value)
  }
  if (typeof value === 'number') {
    return new expressionData.NumberData(value)
  }
  if (typeof value === 'string') {
    return new expressionData.StringData(value)
  }
  if (Array.isArray(value)) {
    return new expressionData.Array(
      ...value.map((item) => toExpressionData(item)),
    )
  }
  if (typeof value === 'object') {
    return new expressionData.Dictionary(
      ...Object.entries(value).map(([key, item]) => ({
        key,
        value: toExpressionData(item),
      })),
    )
  }
  return new expressionData.Null()
}

function dataValue(value: ExpressionData): unknown {
  if (value instanceof expressionData.Array) {
    return value.values().map((item) => dataValue(item))
  }
  if (value instanceof expressionData.BooleanData) {
    return value.value
  }
  if (value instanceof expressionData.Dictionary) {
    return Object.fromEntries(
      value.pairs().map((pair) => [pair.key, dataValue(pair.value)]),
    )
  }
  if (value instanceof expressionData.Null) {
    return null
  }
  if (value instanceof expressionData.NumberData) {
    return value.value
  }
  if (value instanceof expressionData.StringData) {
    return value.value
  }
  return null
}

function replacementForIndexAccess(
  expr: IndexAccess,
  values: Record<string, unknown>,
): string | undefined {
  if (!hasValueForIndexAccess(expr, values)) {
    return
  }
  const value = valueForIndexAccess(expr, values)
  if (typeof value === 'string') {
    const body = expressionBody(value.trim())
    if (body !== undefined) {
      return `(${body})`
    }
  }
  return valueLiteral(value)
}

function hasStaticValueForIndexAccess(
  expr: IndexAccess,
  values: Record<string, unknown>,
): boolean {
  if (!hasValueForIndexAccess(expr, values)) {
    return false
  }
  const value = valueForIndexAccess(expr, values)
  return typeof value !== 'string' || expressionBody(value.trim()) === undefined
}

function printIndexAccess(
  expr: IndexAccess,
  values: Record<string, unknown>,
): string {
  const target = printExpression(expr.expr, values)
  if (expr.index instanceof Literal) {
    return expr.index.token.value === undefined
      ? `${target}.${expr.index.token.lexeme}`
      : `${target}[${expr.index.token.lexeme}]`
  }
  return `${target}[${printExpression(expr.index, values)}]`
}

function printFunctionExpression(
  expr: FunctionCall,
  values: Record<string, unknown>,
): string {
  const format = printFormatExpression(expr, values)
  if (format) {
    return format
  }
  return `${expr.functionName.lexeme}(${expr.args.map((arg) => printExpression(arg, values)).join(', ')})`
}

function printFormatExpression(
  expr: FunctionCall,
  values: Record<string, unknown>,
): string | undefined {
  if (expr.functionName.lexeme.toLowerCase() !== 'format') {
    return
  }
  const [formatArg, ...args] = expr.args
  if (!formatArg) {
    return
  }
  const format = staticExpression(formatArg, values)
  if (typeof format?.value !== 'string') {
    return
  }
  const simplified = simplifyFormatString(
    format.value,
    args.map((arg) => ({
      static: staticExpression(arg, values),
      text: printExpression(arg, values),
    })),
  )
  if (!simplified) {
    return
  }
  if (simplified.args.length === 0) {
    return quoteExpressionString(simplified.format)
  }
  return `format(${quoteExpressionString(simplified.format)}, ${simplified.args.join(', ')})`
}

function simplifyFormatString(
  format: string,
  args: { static?: StaticExpression; text: string }[],
): { args: string[]; format: string } | undefined {
  const nextArgs: string[] = []
  let nextFormat = ''
  let index = 0

  while (index < format.length) {
    const char = format[index]
    const nextChar = format[index + 1]
    if (char === '{' && nextChar === '{') {
      nextFormat += '{{'
      index += 2
      continue
    }
    if (char === '}' && nextChar === '}') {
      nextFormat += '}}'
      index += 2
      continue
    }
    if (char !== '{') {
      nextFormat += char
      index += 1
      continue
    }

    const end = format.indexOf('}', index + 1)
    if (end === -1) {
      return
    }
    const rawIndex = /^\d+/u.exec(format.slice(index + 1, end))?.[0]
    if (!rawIndex) {
      return
    }
    const arg = args[Number(rawIndex)]
    if (!arg) {
      return
    }
    if (arg.static) {
      nextFormat += arg.static.data
        .coerceString()
        .replaceAll('{', '{{')
        .replaceAll('}', '}}')
    } else {
      const nextIndex = nextArgs.push(arg.text) - 1
      nextFormat += `{${nextIndex}}`
    }
    index = end + 1
  }

  nextFormat = nextFormat.trim()
  return { args: nextArgs, format: nextFormat }
}
