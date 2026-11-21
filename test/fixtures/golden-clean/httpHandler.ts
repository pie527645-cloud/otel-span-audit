import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OrderService, type OrderRecord } from './orderService.js';
import { serviceTracer } from './telemetry.js';

const orders = new OrderService();

export async function handleCheckoutRequest(payload: OrderRecord): Promise<{ receipt: string }> {
  return serviceTracer.startActiveSpan('http.post.checkout', async (span) => {
    try {
      orders.annotateCurrentContext('web-checkout');
      await orders.reserveInventory(payload);
      const receipt = await orders.chargePayment(payload);
      return { receipt };
    } catch (err) {
      const current = trace.getActiveSpan() ?? span;
      current.recordException(err as Error);
      current.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
