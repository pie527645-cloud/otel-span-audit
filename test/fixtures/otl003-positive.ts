import * as otel from '@opentelemetry/api';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('otl003-positive');

declare function riskySyncOp(): void;

// 1. startSpan catch missing setStatus
export function missingStatusOnStartSpan(): void {
  const span = tracer.startSpan('op.missing1');
  try {
    riskySyncOp();
  } catch (err) {
    span.recordException(err as Error);
    throw err;
  } finally {
    span.end();
  }
}

// 2. startActiveSpan catch missing setStatus
export function missingStatusOnActiveSpan(): void {
  tracer.startActiveSpan('op.missing2', (span) => {
    try {
      riskySyncOp();
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

// 3. trace.getActiveSpan() catch missing setStatus
export function missingStatusOnBorrowedActiveSpan(): void {
  try {
    riskySyncOp();
  } catch (err) {
    const active = trace.getActiveSpan();
    active?.recordException(err as Error);
  }
}

// 4. Typed Span parameter setting SpanStatusCode.OK (1) instead of ERROR
export function wrongStatusOk(span: Span): void {
  try {
    riskySyncOp();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.OK });
  }
}

// 5. Typed otel.Span parameter setting SpanStatusCode.UNSET (0) and numeric 0
export function wrongStatusUnsetAndZero(span: otel.Span): void {
  try {
    riskySyncOp();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: otel.SpanStatusCode.UNSET });
  }

  try {
    riskySyncOp();
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: 0 });
  }
}
