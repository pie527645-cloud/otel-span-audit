import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

export const serviceTracer: Tracer = trace.getTracer('checkout-service', '2.1.0');

export function getCheckoutTracer(): Tracer {
  return serviceTracer;
}

export function recordSpanFailure(span: Span, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  span.recordException(err instanceof Error ? err : new Error(message));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message,
  });
}
