import { context, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

const tracer = trace.getTracer('orders-clean', '1.0.0');

declare function fetchRemote(url: string): Promise<string>;
declare function computeSyncChecksum(payload: string): string;

// 1. Standard try/finally with non-throwing setup and context.with(trace.setSpan(...))
export async function cleanTryFinallyWithSetup(url: string): Promise<string> {
  const span = tracer.startSpan('orders.fetch');
  span.setAttribute('http.url', url);
  span.addEvent('request.start');
  const subCtx = trace.setSpan(context.active(), span);
  try {
    return await context.with(subCtx, () => fetchRemote(url));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

// 2. Enclosing try/finally around let span assignment with optional chaining & if-guard
export async function cleanEnclosingTryOptionalEnd(url: string): Promise<string> {
  let span: Span | undefined;
  try {
    span = tracer.startSpan('orders.enclosingOptional');
    return await fetchRemote(url);
  } finally {
    span?.end();
  }
}

export async function cleanEnclosingTryIfGuard(url: string): Promise<string> {
  let span: Span | undefined;
  try {
    span = tracer.startSpan('orders.enclosingGuard');
    return await fetchRemote(url);
  } finally {
    if (span) {
      span.end();
    }
  }
}

// 3. try/catch without finally ending span on EVERY path
export async function cleanTryAndCatchBothEnd(url: string): Promise<string> {
  const span = tracer.startSpan('orders.tryCatchBothEnd');
  try {
    const body = await fetchRemote(url);
    span.end();
    return body;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    throw err;
  }
}

// 4. Straight-line synchronous block and sync branches ending on every path
export function cleanSyncAllPaths(payload: string, skipChecksum: boolean): string {
  const span = tracer.startSpan('orders.checksum');
  if (skipChecksum) {
    span.setAttribute('skipped', true);
    span.end();
    return 'skipped';
  }
  const digest = computeSyncChecksum(payload);
  span.setAttribute('digest', digest);
  span.end();
  return digest;
}

// 5. Returned promise chain ending with .finally(() => span.end())
export function cleanPromiseFinally(url: string): Promise<string> {
  const span = tracer.startSpan('orders.promiseFinally');
  return fetchRemote(url)
    .then((res) => res.trim())
    .finally(() => {
      span.end();
    });
}

// 6. Immediate chained .end()
export function cleanImmediateMarker(injectedTracer: Tracer): void {
  injectedTracer.startSpan('orders.marker').setAttribute('marker', true).end();
}

// 7. trace.getActiveSpan() borrows an active span that the caller MUST NOT end
export function cleanBorrowedActiveSpan(orderId: string): void {
  const active = trace.getActiveSpan();
  active?.setAttribute('order.id', orderId);
}
