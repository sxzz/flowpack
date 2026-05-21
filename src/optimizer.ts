import {
  expressionBody,
  staticIfExpression,
  type StaticIfValue,
} from './utils/expression.ts'
import { asRecord } from './utils/yaml.ts'

export function optimizeJob(
  job: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...job }
  if (Array.isArray(next.needs) && next.needs.length === 0) {
    delete next.needs
  }
  if (staticIfValue(next.if) === true) {
    delete next.if
  }
  return next
}

export function optimizeStep(stepValue: unknown): unknown | undefined {
  const step = asRecord(stepValue)
  if (!step) {
    return stepValue
  }
  const ifValue = staticIfValue(step.if)
  if (ifValue === false || ifValue === '') {
    return
  }
  if (ifValue === true) {
    const next = { ...step }
    delete next.if
    return next
  }
  return stepValue
}

export function optimizeJobs(
  jobs: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(jobs).map(([jobId, jobValue]) => {
      const job = asRecord(jobValue)
      return [jobId, job ? optimizeJob(job) : jobValue]
    }),
  )
}

function staticIfValue(value: unknown): StaticIfValue | undefined {
  if (value === true || value === false || value === '') {
    return value
  }
  if (typeof value !== 'string') {
    return
  }
  const trimmed = value.trim()
  return staticIfExpression(expressionBody(trimmed) ?? trimmed)
}
