import * as otel from '@opentelemetry/api';
import { SpanStatusCode as MyStatusCode, trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('otl003-clean');

declare function riskySyncOp(): void;
declare function deriveStatusCode(err: unknown): number;

// 1. SpanStatusCode.ERROR (aliased)
export function cleanAliasedErrorStatus(): void {
  const span = tracer.startSpan('op.clean1');
  try {
    riskySyncOp();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: MyStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    span.end();
  }
}

// 2. Namespaced otel.SpanStatusCode.ERROR
export function cleanNamespacedErrorStatus(): void {
  try {
    riskySyncOp();
  } catch (err) {
    const span = otel.trace.getActiveSpan();
    span?.recordException(err as Error);
    span?.setStatus({ code: otel.SpanStatusCode.ERROR });
  }
}

// 3. Numeric literal 2
export function cleanNumericTwoErrorStatus(span: Span): void {
  try {
    riskySyncOp();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: 2, message: 'database failure' });
  }
}

// 4. Dynamic helper variable not statically OK/1 or UNSET/0
export function cleanDynamicHelperStatus(span: Span): void {
  try {
    riskySyncOp();
  } catch (err) {
    const computed = deriveStatusCode(err);
    span.recordException(err as Error);
    span.setStatus({ code: computed });
  }
}

// 5. recordException outside catch block MUST NOT be flagged
export function cleanRecordExceptionOutsideCatch(span: Span, warningErr: Error): void {
  span.recordException(warningErr);
}
