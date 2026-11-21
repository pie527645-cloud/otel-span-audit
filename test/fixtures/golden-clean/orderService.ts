import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { getCheckoutTracer, recordSpanFailure, serviceTracer } from './telemetry.js';

export interface OrderRecord {
  readonly id: string;
  readonly cents: number;
}

export class OrderService {
  private readonly tracer = getCheckoutTracer();

  public async reserveInventory(order: OrderRecord): Promise<boolean> {
    const span = this.tracer.startSpan('inventory.reserve');
    span.setAttribute('order.id', order.id);
    span.setAttribute('order.cents', order.cents);
    try {
      await Promise.resolve(order.id);
      return true;
    } catch (err) {
      recordSpanFailure(span, err);
      throw err;
    } finally {
      span.end();
    }
  }

  public async chargePayment(order: OrderRecord): Promise<string> {
    return serviceTracer.startActiveSpan(
      'payment.charge',
      { attributes: { 'order.id': order.id } },
      context.active(),
      async (span) => {
        try {
          const receipt = await Promise.resolve(`rcpt_${order.id}`);
          span.setAttribute('payment.receipt', receipt);
          return receipt;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      }
    );
  }

  public annotateCurrentContext(tag: string): void {
    const active = trace.getActiveSpan();
    active?.setAttribute('checkout.tag', tag);
  }
}
