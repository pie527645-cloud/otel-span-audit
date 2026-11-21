import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSourceFile, checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('OTL001 — local startSpan() lifecycle & escape analysis', () => {
  it('flags all positive unended or unprotected local startSpan() cases', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl001-positive.ts'),
    });
    const otl001 = report.findings.filter((f) => f.ruleId === 'OTL001');
    assert.equal(otl001.length, 8);
    assert.ok(otl001.every((f) => f.severity === 'medium'));
    assert.equal(report.findings.length, 8);
  });

  it('stays clean on try/finally, enclosing try, try+catch all-paths, sync all-paths, .finally(), and trace.getActiveSpan()', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl001-clean.ts'),
    });
    assert.deepEqual(report.findings, []);
  });

  it('skips spans that escape via return, concise arrow, helper argument, or object/field/collection storage', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl001-escape.ts'),
    });
    assert.deepEqual(report.findings, []);
  });

  it('supports CommonJS require("@opentelemetry/api") and skips files without @opentelemetry/api', () => {
    const cjsLeaky = analyzeSourceFile(
      'cjs-worker.cjs',
      [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("cjs");',
        'function run() {',
        '  const span = tracer.startSpan("work");',
        '  span.setAttribute("k", "v");',
        '}',
      ].join('\n')
    );
    assert.equal(cjsLeaky.length, 1);
    assert.equal(cjsLeaky[0]?.ruleId, 'OTL001');

    const nonOtelReport = checkProject({
      target: path.join(FIXTURES_DIR, 'non-otel.ts'),
    });
    assert.deepEqual(nonOtelReport.findings, []);

    const typedParamLeaky = analyzeSourceFile(
      'typed-tracer.ts',
      [
        'import type { Tracer } from "@opentelemetry/api";',
        'export function runWithInjectedTracer(tracer: Tracer): void {',
        '  const span = tracer.startSpan("injected.leak");',
        '  span.setAttribute("ok", true);',
        '}',
      ].join('\n')
    );
    assert.equal(typedParamLeaky.length, 1);
    assert.equal(typedParamLeaky[0]?.ruleId, 'OTL001');
  });
});
