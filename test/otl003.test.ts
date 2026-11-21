import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSourceFile, checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('OTL003 — catch-block span.recordException() without ERROR status', () => {
  it('flags catch blocks calling recordException() without setStatus(ERROR) or setting OK/UNSET/0/1', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl003-positive.ts'),
    });
    assert.equal(report.findings.length, 6);
    assert.ok(report.findings.every((f) => f.ruleId === 'OTL003' && f.severity === 'low'));

    const numericOne = analyzeSourceFile(
      'numeric-ok.ts',
      [
        'import type { Span } from "@opentelemetry/api";',
        'export function handle(span: Span): void {',
        '  try { throw new Error("x"); } catch (e) {',
        '    span.recordException(e as Error);',
        '    span.setStatus({ code: 1 });',
        '  }',
        '}',
      ].join('\n')
    );
    assert.equal(numericOne.length, 1);
    assert.equal(numericOne[0]?.ruleId, 'OTL003');
  });

  it('stays clean on SpanStatusCode.ERROR, aliased/namespaced ERROR, numeric 2, dynamic helper status, and non-catch calls', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl003-clean.ts'),
    });
    assert.deepEqual(report.findings, []);
  });

  it('skips catch blocks where span escapes to a helper such as markSpanError(span, err)', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl003-escape.ts'),
    });
    assert.deepEqual(report.findings, []);
  });

  it('ignores non-OTel recordException() methods even when @opentelemetry/api is imported in the same file', () => {
    const findings = analyzeSourceFile(
      'mixed-logger.ts',
      [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'interface CustomErrorSink { recordException(err: unknown): void; }',
        'export function run(sink: CustomErrorSink): void {',
        '  const span = tracer.startSpan("op");',
        '  try {',
        '    throw new Error("boom");',
        '  } catch (err) {',
        '    sink.recordException(err);',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n')
    );
    assert.deepEqual(findings, []);
  });
});
