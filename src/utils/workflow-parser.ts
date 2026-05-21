import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION_ROOT } from '@actions/workflow-parser/actions/action-constants'
import { JSONObjectReader } from '@actions/workflow-parser/templates/json-object-reader'
import { TemplateSchema } from '@actions/workflow-parser/templates/schema/index'
import {
  TemplateContext,
  TemplateValidationErrors,
} from '@actions/workflow-parser/templates/template-context'
import { readTemplate } from '@actions/workflow-parser/templates/template-reader'
import {
  isBasicExpression,
  isBoolean,
  isMapping,
  isNumber,
  isSequence,
  isString,
} from '@actions/workflow-parser/templates/tokens/type-guards'
import { NoOperationTraceWriter } from '@actions/workflow-parser/templates/trace-writer'
import { WORKFLOW_ROOT } from '@actions/workflow-parser/workflows/workflow-constants'
import { YamlObjectReader } from '@actions/workflow-parser/workflows/yaml-object-reader'
import type { TemplateParseResult } from '@actions/workflow-parser/templates/template-parse-result'
import type { TemplateToken } from '@actions/workflow-parser/templates/tokens/index'

const workflowParserEntry = fileURLToPath(
  import.meta.resolve('@actions/workflow-parser'),
)
const workflowParserDist = path.dirname(workflowParserEntry)
let actionSchema: TemplateSchema | undefined
let workflowSchema: TemplateSchema | undefined

export function parseWorkflowMap(
  source: string,
  file: string,
): Record<string, unknown> {
  workflowSchema ??= loadSchema('workflow-v1.0.min.json')
  return parseTemplateMap(WORKFLOW_ROOT, workflowSchema, source, file)
}

export function parseActionMap(
  source: string,
  file: string,
): Record<string, unknown> {
  return parseTemplateMap(ACTION_ROOT, actionSchemaForParser(), source, file)
}

function parseTemplateMap(
  root: string,
  schema: TemplateSchema,
  source: string,
  file: string,
): Record<string, unknown> {
  const result = parseTemplate(root, schema, source, file)
  throwOnTemplateErrors(result, file)
  if (!result.value) {
    return {}
  }
  const value = templateTokenToValue(result.value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${file} must be a YAML mapping`)
  }
  return value as Record<string, unknown>
}

export function parseActionTemplate(
  source: string,
  file: string,
): TemplateParseResult {
  return parseTemplate(ACTION_ROOT, actionSchemaForParser(), source, file)
}

function parseTemplate(
  root: string,
  schema: TemplateSchema,
  source: string,
  file: string,
): TemplateParseResult {
  const context = new TemplateContext(
    new TemplateValidationErrors(),
    schema,
    new NoOperationTraceWriter(),
  )
  const fileId = context.getFileId(file)
  const reader = new YamlObjectReader(fileId, source)
  if (reader.errors.length > 0) {
    for (const error of reader.errors) {
      context.error(fileId, error.message, error.range)
    }
    return { context, value: undefined }
  }
  return {
    context,
    value: readTemplate(context, root, reader, fileId),
  }
}

function throwOnTemplateErrors(
  result: TemplateParseResult,
  file: string,
): void {
  const errors = result.context.errors.getErrors()
  if (errors.length > 0) {
    throw new Error(
      `${file}: ${errors.map((error) => error.message).join('\n')}`,
    )
  }
}

export function templateTokenToValue(token: TemplateToken): unknown {
  if (isMapping(token)) {
    return Object.fromEntries(
      [...token].map((pair) => [
        String(templateTokenToValue(pair.key)),
        templateTokenToValue(pair.value),
      ]),
    )
  }
  if (isSequence(token)) {
    return [...token].map((item) => templateTokenToValue(item))
  }
  if (isString(token) || isNumber(token) || isBoolean(token)) {
    return token.value
  }
  if (isBasicExpression(token)) {
    return token.toString()
  }
  return token.toJSON()
}

function actionSchemaForParser(): TemplateSchema {
  actionSchema ??= loadSchema('action-v1.0.min.json')
  return actionSchema
}

function loadSchema(name: string): TemplateSchema {
  const file = path.join(workflowParserDist, name)
  return TemplateSchema.load(
    new JSONObjectReader(undefined, readFileSync(file, 'utf8')),
  )
}
