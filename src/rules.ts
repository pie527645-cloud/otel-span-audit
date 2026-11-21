import type {
  FailOnThreshold,
  Finding,
  RuleId,
  RuleMetadata,
  Severity,
  SeveritySummary,
} from './types.js';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const RULES: readonly RuleMetadata[] = [
  {
    id: 'OTL001',
    name: 'unended-local-span',
    defaultSeverity: 'medium',
    shortDescription: 'Local startSpan() span is not ended on every execution path.',
    fullDescription:
      'Detects OpenTelemetry tracer.startSpan() spans stored in local variables or left unassigned where span.end() is missing or bypassed by an early return, throw, catch branch, or unprotected await.',
    helpText:
      'Wrap work after startSpan() in try/finally calling span.end(), end the span on every synchronous and exception path, or return a promise chain ending with .finally(() => span.end()).',
  },
  {
    id: 'OTL002',
    name: 'unended-active-span-callback',
    defaultSeverity: 'medium',
    shortDescription:
      'startActiveSpan() callback omits span.end() or calls it after an unprotected await.',
    fullDescription:
      'Detects OpenTelemetry tracer.startActiveSpan() inline callbacks across 2-, 3-, and 4-argument overloads that omit the span parameter, never call span.end(), or call span.end() only after an await or fallible path outside try/finally. OpenTelemetry JS does not automatically end active spans when the callback settles.',
    helpText:
      'Accept the span callback parameter and ensure span.end() executes inside a finally block (or .finally(() => span.end()) on a returned promise chain).',
  },
  {
    id: 'OTL003',
    name: 'record-exception-without-error-status',
    defaultSeverity: 'low',
    shortDescription:
      'span.recordException() in catch block without span.setStatus({ code: SpanStatusCode.ERROR }).',
    fullDescription:
      'Detects span.recordException(err) calls inside catch blocks that omit span.setStatus({ code: SpanStatusCode.ERROR }) on the same span in that catch block, or that set SpanStatusCode.OK (1) or SpanStatusCode.UNSET (0). In OpenTelemetry, recordException() only appends an exception event and leaves the span status unset unless ERROR status is explicitly recorded.',
    helpText:
      'Call span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) }) alongside span.recordException(err) in the catch block.',
  },
];

export const RULE_MAP: ReadonlyMap<RuleId, RuleMetadata> = new Map(
  RULES.map((rule) => [rule.id, rule])
);

export function summarizeFindings(findings: readonly Finding[]): SeveritySummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let info = 0;

  for (const finding of findings) {
    switch (finding.severity) {
      case 'high':
        high += 1;
        break;
      case 'medium':
        medium += 1;
        break;
      case 'low':
        low += 1;
        break;
      case 'info':
        info += 1;
        break;
    }
  }

  return {
    total: findings.length,
    high,
    medium,
    low,
    info,
  };
}

export function exceedsFailOnThreshold(
  findings: readonly Finding[],
  failOn: FailOnThreshold
): boolean {
  if (failOn === 'none') {
    return false;
  }
  const minRank = SEVERITY_RANK[failOn];
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= minRank);
}
