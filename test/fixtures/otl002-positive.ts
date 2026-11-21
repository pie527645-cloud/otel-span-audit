import { context, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('active-span-positive');

declare function queryDb(sql: string): Promise<number>;

// 1. 2-arg overload never calling span.end()
export async function leakyTwoArg(sql: string): Promise<number> {
  return tracer.startActiveSpan('db.query2', async (span) => {
    span.setAttribute('db.statement', sql);
    return await queryDb(sql);
  });
}

// 2. 3-arg overload calling span.end() AFTER await outside try/finally
export async function leakyThreeArgAwait(sql: string): Promise<number> {
  return tracer.startActiveSpan('db.query3', { kind: 1 }, async (span) => {
    const count = await queryDb(sql);
    span.end();
    return count;
  });
}

// 3. 4-arg overload skipping span.end() on early return
export function leakyFourArgEarlyReturn(flag: boolean): string {
  return tracer.startActiveSpan(
    'db.query4',
    { attributes: { fast: true } },
    context.active(),
    (span) => {
      if (flag) {
        return 'early';
      }
      span.end();
      return 'done';
    }
  );
}

// 4. 0-parameter callback (OTel JS does NOT auto-end active spans)
export async function leakyZeroParamCallback(sql: string): Promise<number> {
  return tracer.startActiveSpan('db.zeroParam', async () => {
    return await queryDb(sql);
  });
}

// 5. try/catch inside callback missing span.end() in catch
export async function leakyCatchInActiveSpan(sql: string): Promise<number> {
  return tracer.startActiveSpan('db.catchLeak', async (span) => {
    try {
      const rows = await queryDb(sql);
      span.end();
      return rows;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    }
  });
}

// 6. Concise arrow promise chain with .then() only (no .finally)
export function leakyPromiseThenActiveSpan(sql: string): Promise<number> {
  return tracer.startActiveSpan('db.thenOnly', (span) =>
    queryDb(sql).then((rows) => {
      span.end();
      return rows;
    })
  );
}
