import { trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('otl003-escape');

declare function riskyOp(): void;
declare function markSpanError(span: Span, err: unknown): void;

export function escapeCatchViaHelper(): void {
  const span = tracer.startSpan('op.catchHelper');
  try {
    riskyOp();
  } catch (err) {
    span.recordException(err as Error);
    markSpanError(span, err);
    throw err;
  } finally {
    span.end();
  }
}

export class TracedRepository {
  private failSpan(span: Span, _err: unknown): void {
    span.setStatus({ code: 2 });
  }

  public execute(span: Span): void {
    try {
      riskyOp();
    } catch (err) {
      span.recordException(err as Error);
      this.failSpan(span, err);
    }
  }
}
