import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildSarifLog,
  checkProject,
  formatJson,
  formatReport,
  formatSarif,
  formatText,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type SarifLog,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('Output formatters (text, json, SARIF v2.1.0)', () => {
  it('formats clean and non-clean reports accurately in text, json, and SARIF v2.1.0', () => {
    const cleanReport = checkProject({
      target: path.join(FIXTURES_DIR, 'golden-clean'),
    });
    const cleanText = formatText(cleanReport);
    assert.ok(cleanText.includes('No OpenTelemetry span lifecycle or status issues found.'));

    const posReport = checkProject({
      target: path.join(FIXTURES_DIR, 'otl002-positive.ts'),
    });

    const textOut = formatReport(posReport, 'text');
    assert.ok(textOut.includes('[MEDIUM] OTL002'));
    assert.ok(textOut.includes('Summary: 6 finding(s)'));

    const jsonOut = formatJson(posReport);
    const parsedJson = JSON.parse(jsonOut) as typeof posReport;
    assert.equal(parsedJson.tool, PACKAGE_NAME);
    assert.equal(parsedJson.version, PACKAGE_VERSION);
    assert.equal(parsedJson.scannedFiles, 1);
    assert.equal(parsedJson.summary.medium, 6);
    assert.equal(parsedJson.findings.length, 6);

    const sarifOut = formatSarif(posReport);
    const sarif = JSON.parse(sarifOut) as SarifLog;
    assert.equal(sarif.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs.length, 1);
    assert.equal(sarif.runs[0].tool.driver.name, PACKAGE_NAME);
    assert.equal(sarif.runs[0].tool.driver.rules.length, 3);
    assert.deepEqual(
      sarif.runs[0].tool.driver.rules.map((r) => r.id),
      ['OTL001', 'OTL002', 'OTL003']
    );
    assert.equal(sarif.runs[0].results.length, 6);
    assert.equal(sarif.runs[0].results[0]?.ruleId, 'OTL002');
    assert.equal(sarif.runs[0].results[0]?.level, 'warning');
    assert.equal(
      sarif.runs[0].results[0]?.locations[0].physicalLocation.artifactLocation.uriBaseId,
      '%SRCROOT%'
    );

    const directSarif = buildSarifLog(posReport);
    assert.equal(directSarif.version, '2.1.0');
  });
});
