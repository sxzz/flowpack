import {
  isBasicExpression,
  isMapping,
  isSequence,
} from '@actions/workflow-parser/templates/tokens/type-guards'
import {
  expressionBody,
  parseExpression,
  printExpression,
  staticExpression,
  valueForIndexAccess,
} from './expression.ts'
import { parseActionTemplate } from './workflow-parser.ts'
import { isRecord } from './yaml.ts'
import type { TemplateToken } from '@actions/workflow-parser/templates/tokens/index'

export function substituteValue(
  value: unknown,
  values: Record<string, unknown>,
  key?: string,
): unknown {
  if (typeof value === 'string') {
    const next = substituteString(value, values)
    return key === 'run' && typeof next === 'string' ? next.trim() : next
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, values))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteValue(item, values, key),
      ]),
    )
  }
  return value
}

export function substituteString(
  value: string,
  values: Record<string, unknown>,
): unknown {
  if (!value.includes('${{')) {
    return value
  }
  const expression = parseCompositeRunExpression(value)
  if (!expression) {
    return value
  }
  try {
    const expr = parseExpression(expression)
    const replacement = valueForIndexAccess(expr, values)
    if (replacement !== undefined) {
      return replacement
    }
    const evaluated = staticExpression(expr, values)
    if (evaluated) {
      return evaluated.value
    }
    const simplified = printExpression(expr, values)
    const staticValue = staticExpression(parseExpression(simplified), values)
    return staticValue ? staticValue.value : `\${{ ${simplified} }}`
  } catch {
    return value
  }
}

export function normalizeInputValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return ''
  }
  return value
}

function parseCompositeRunExpression(value: string): string | undefined {
  const expression = expressionBody(value.trim())
  if (expression !== undefined) {
    return expression
  }

  const content = `runs:
  using: composite
  steps:
    - run: ${JSON.stringify(value)}
`
  const result = parseActionTemplate(
    content,
    'actionspack-substitute/action.yml',
  )
  if (!result.value) {
    return
  }
  const token = findToken(result.value, ['runs', 'steps', '0', 'run'])
  return token && isBasicExpression(token) ? token.expression : undefined
}

function findToken(
  token: TemplateToken,
  path: readonly string[],
): TemplateToken | undefined {
  if (path.length === 0) {
    return token
  }
  const [head, ...rest] = path
  if (isMapping(token)) {
    const next = token.find(head!)
    return next ? findToken(next, rest) : undefined
  }
  if (isSequence(token)) {
    const index = Number(head)
    return Number.isInteger(index)
      ? findToken(token.get(index), rest)
      : undefined
  }
  return
}
