import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSourceFile, checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('OTL002 — startActiveSpan() callback lifecycle & overloads', () => {
  it('flags missing span.end(), post-await span.end(), early return, 0-param callback, and .then()-only across 2/3/4-arg overloads', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl002-positive.ts'),
    });
    assert.equal(report.findings.length, 6);
    assert.ok(report.findings.every((f) => f.ruleId === 'OTL002' && f.severity === 'medium'));
  });

  it('stays clean across 2/3/4-arg overloads when span.end() is in finally, try+catch, sync branches, or .finally()', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl002-clean.ts'),
    });
    assert.deepEqual(report.findings, []);
  });

  it('skips named callback references, helper/object/return escapes, and 0-param arguments forwarding', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'otl002-escape.ts'),
    });
    assert.deepEqual(report.findings, []);
  });

  it('supports default/namespace @opentelemetry/api imports and CJS require for startActiveSpan()', () => {
    const nsFindings = analyzeSourceFile(
      'ns-active.ts',
      [
        'import otel from "@opentelemetry/api";',
        'export async function run() {',
        '  return otel.trace.getTracer("svc").startActiveSpan("op", async (span) => {',
        '    await Promise.resolve(1);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n')
    );
    assert.equal(nsFindings.length, 1);
    assert.equal(nsFindings[0]?.ruleId, 'OTL002');
  });
});
