import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('orders-service', '1.0.0');

declare function fetchRemote(url: string): Promise<string>;
declare function validateInput(id: string): boolean;

// 1. Local startSpan never ended
export function leakedSimpleSpan(orderId: string): string {
  const span = tracer.startSpan('orders.lookup');
  span.setAttribute('order.id', orderId);
  return `order:${orderId}`;
}

// 2. Unassigned startSpan call
export function leakedUnassignedSpan(): void {
  trace.getTracer('inline-svc').startSpan('orphan.operation');
}

// 3. await before span.end() outside try/finally
export async function leakedOnAwaitRejection(url: string): Promise<string> {
  const span = tracer.startSpan('http.fetch');
  const body = await fetchRemote(url);
  span.end();
  return body;
}

// 4. Early return bypassing span.end()
export function leakedOnEarlyReturn(id: string): boolean {
  const span = tracer.startSpan('orders.validate');
  if (!id) {
    return false;
  }
  const ok = validateInput(id);
  span.end();
  return ok;
}

// 5. Uncaught throw before span.end() outside try/finally
export function leakedOnDirectThrow(id: string): void {
  const span = tracer.startSpan('orders.assert');
  if (!validateInput(id)) {
    throw new Error('Invalid order ID');
  }
  span.end();
}

// 6. try/catch without finally where catch omits span.end()
export async function leakedInCatchBranch(url: string): Promise<string> {
  const span = tracer.startSpan('http.tryCatchLeak');
  try {
    const data = await fetchRemote(url);
    span.end();
    return data;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  }
}

// 7. Returned promise chain with .then(() => span.end()) missing .finally / rejection path
export function leakedPromiseThenOnly(url: string): Promise<string> {
  const span = tracer.startSpan('http.promiseThenOnly');
  return fetchRemote(url).then((res) => {
    span.end();
    return res;
  });
}

// 8. Class field tracer missing span.end()
export class OrderWorker {
  private readonly tracer = trace.getTracer('order-worker');

  public runJob(jobId: string): void {
    const span = this.tracer.startSpan('job.execute');
    span.setAttribute('job.id', jobId);
  }
}
