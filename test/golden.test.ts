import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'golden-clean');

describe('Golden multi-file clean OpenTelemetry service', () => {
  it('scans all 3 service files with 0 findings', () => {
    const report = checkProject({ target: GOLDEN_DIR });
    assert.equal(report.scannedFiles, 3);
    assert.equal(report.summary.total, 0);
    assert.deepEqual(report.findings, []);
  });
});
