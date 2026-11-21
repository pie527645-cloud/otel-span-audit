import { trace, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('active-span-escape');

declare function externalSpanCallback(span: Span): Promise<void>;
declare function executeWithManagedSpan(span: Span): Promise<string>;
declare function forwardArguments(args: IArguments): void;

// 1. Named callback reference passed as last argument (skip conservatively)
export function escapeNamedHandlerReference(): Promise<void> {
  return tracer.startActiveSpan('op.namedRef', externalSpanCallback);
}

// 2. Callback passing span to helper
export function escapePassedToHelper(): Promise<string> {
  return tracer.startActiveSpan('op.helperEscape', (span) => executeWithManagedSpan(span));
}

// 3. Callback returning span or storing on object
export function escapeReturnedAndStored(holder: { span?: Span }): Span {
  tracer.startActiveSpan('op.stored', (s) => {
    holder.span = s;
  });
  return tracer.startActiveSpan('op.returned', (s) => s);
}

// 4. 0-parameter function expression forwarding arguments
export function escapeZeroParamViaArguments(): void {
  tracer.startActiveSpan('op.arguments', function () {
    forwardArguments(arguments);
  });
}
