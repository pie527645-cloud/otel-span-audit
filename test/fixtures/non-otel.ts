// Custom telemetry facade with NO @opentelemetry/api import: MUST produce 0 findings.
class CustomSpan {
  public recordException(_err: unknown): void {}
  public end(): void {}
}

class CustomTracer {
  public startSpan(_name: string): CustomSpan {
    return new CustomSpan();
  }

  public startActiveSpan<T>(_name: string, fn: (span: CustomSpan) => T): T {
    return fn(new CustomSpan());
  }
}

const customTracer = new CustomTracer();

export async function runCustomInstrumentation(): Promise<void> {
  const span = customTracer.startSpan('custom.unended');
  await Promise.resolve(span);

  await customTracer.startActiveSpan('custom.active', async () => {
    try {
      throw new Error('boom');
    } catch (err) {
      const s = customTracer.startSpan('custom.catch');
      s.recordException(err);
    }
  });
}
