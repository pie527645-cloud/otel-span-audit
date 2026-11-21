import { context, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

const getAppTracer = () => trace.getTracer('active-span-clean');

declare function queryDb(sql: string): Promise<number>;

// 1. 2-arg overload with try/finally
export async function cleanTwoArg(sql: string): Promise<number> {
  return getAppTracer().startActiveSpan('db.clean2', async (span) => {
    try {
      return await queryDb(sql);
    } finally {
      span.end();
    }
  });
}

// 2. 3-arg overload with try/finally
export async function cleanThreeArg(sql: string): Promise<number> {
  return getAppTracer().startActiveSpan('db.clean3', { kind: 1 }, async (span) => {
    try {
      return await queryDb(sql);
    } finally {
      span.end();
    }
  });
}

// 3. 4-arg overload with try/finally
export async function cleanFourArg(sql: string, injectedTracer: Tracer): Promise<number> {
  return injectedTracer.startActiveSpan(
    'db.clean4',
    { kind: 1 },
    context.active(),
    async (span) => {
      try {
        return await queryDb(sql);
      } finally {
        span.end();
      }
    }
  );
}

// 4. try/catch ending span on both paths without finally
export async function cleanTryCatchActiveSpan(sql: string): Promise<number> {
  return getAppTracer().startActiveSpan('db.cleanTryCatch', async (span) => {
    try {
      const rows = await queryDb(sql);
      span.end();
      return rows;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  });
}

// 5. Concise promise chain with .finally(() => span.end())
export function cleanPromiseFinallyActiveSpan(sql: string): Promise<number> {
  return getAppTracer().startActiveSpan('db.cleanPromiseFinally', (span) =>
    queryDb(sql).finally(() => span.end())
  );
}

// 6. Sync all-paths if/else
export function cleanSyncBranchesActiveSpan(flag: boolean): number {
  return getAppTracer().startActiveSpan('db.syncBranches', (span) => {
    if (flag) {
      span.end();
      return 1;
    } else {
      span.end();
      return 0;
    }
  });
}
