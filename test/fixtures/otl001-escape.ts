import { trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('orders-escape');

declare function finishLater(span: Span): void;

export interface SpanEnvelope {
  readonly span: Span;
}

// 1. Returned directly, in object, in array, and via concise arrow
export function escapeReturnDirect(): Span {
  const span = tracer.startSpan('escape.direct');
  return span;
}

export function escapeReturnObject(): SpanEnvelope {
  const span = tracer.startSpan('escape.object');
  return { span };
}

export function escapeReturnArray(): Span[] {
  const span = tracer.startSpan('escape.array');
  return [span];
}

export const escapeConciseArrow = (): Span => tracer.startSpan('escape.arrow');

// 2. Passed as helper/constructor argument
export function escapeViaHelper(): void {
  const span = tracer.startSpan('escape.helper');
  finishLater(span);
}

// 3. Stored on class field, context object, array, and Map
export class SpanHolder {
  private activeSpan?: Span;
  private readonly spans: Span[] = [];
  private readonly byId = new Map<string, Span>();

  public startOnField(ctx: { span?: Span }, id: string): void {
    const s1 = tracer.startSpan('escape.field');
    this.activeSpan = s1;

    const s2 = tracer.startSpan('escape.ctxProp');
    ctx.span = s2;

    const s3 = tracer.startSpan('escape.arrayPush');
    this.spans.push(s3);

    const s4 = tracer.startSpan('escape.mapSet');
    this.byId.set(id, s4);
  }

  public stopAll(): void {
    this.activeSpan?.end();
  }
}
