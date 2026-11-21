import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import type { CheckReport, SarifLog } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');

interface CliExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeSubprocessCli(
  args: readonly string[],
  cwd: string = REPO_ROOT
): CliExecResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 15_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : 2,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? ''),
    };
  }
}

describe('CLI contract, thresholds, and exit codes (0 / 1 / 2)', () => {
  it('ensures dist/cli.js starts with LF #!/usr/bin/env node shebang and zero CRLF', () => {
    const raw = fs.readFileSync(CLI_PATH, 'utf8');
    assert.equal(raw.startsWith('#!/usr/bin/env node\n'), true);
    assert.equal(raw.includes('\r\n'), false);
  });

  it('handles --help and --version with exit code 0', () => {
    const out: string[] = [];
    const code = runCli(['--help'], {
      stdout: (m) => out.push(m),
      stderr: () => {},
    });
    assert.equal(code, 0);
    assert.ok(out.join('\n').includes('otel-span-audit check [path]'));

    const verRes = invokeSubprocessCli(['--version']);
    assert.equal(verRes.status, 0);
    assert.equal(verRes.stdout.trim(), '1.0.0');
  });

  it('returns 0 on self-check and enforces --fail-on and --include-tests accurately', () => {
    const selfRes = invokeSubprocessCli(['check', '.', '--format', 'json']);
    assert.equal(selfRes.status, 0);
    const selfReport = JSON.parse(selfRes.stdout) as CheckReport;
    assert.equal(selfReport.summary.total, 0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-cli-thresholds-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

      // OTL003 (low) in src/handler.ts
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'handler.ts'),
        [
          'import { trace } from "@opentelemetry/api";',
          'export function handle(): void {',
          '  try {',
          '    throw new Error("fail");',
          '  } catch (err) {',
          '    const active = trace.getActiveSpan();',
          '    active?.recordException(err as Error);',
          '  }',
          '}',
        ].join('\n'),
        'utf8'
      );

      // OTL001 (medium) in test/leaky.test.ts (excluded unless --include-tests)
      fs.writeFileSync(
        path.join(tmpDir, 'test', 'leaky.test.ts'),
        [
          'import { trace } from "@opentelemetry/api";',
          'const tracer = trace.getTracer("test");',
          'export function testLeak(): void {',
          '  const span = tracer.startSpan("leak");',
          '  span.setAttribute("x", 1);',
          '}',
        ].join('\n'),
        'utf8'
      );

      // Default --fail-on medium: 1 low finding -> exit code 0
      const defaultRes = invokeSubprocessCli(['check', tmpDir, '--format', 'json']);
      assert.equal(defaultRes.status, 0);
      const defaultReport = JSON.parse(defaultRes.stdout) as CheckReport;
      assert.equal(defaultReport.summary.total, 1);
      assert.equal(defaultReport.summary.low, 1);

      // --fail-on low: 1 low finding >= low -> exit code 1
      const lowFailRes = invokeSubprocessCli(['check', tmpDir, '--fail-on', 'low']);
      assert.equal(lowFailRes.status, 1);

      // --include-tests (default --fail-on medium): picks up OTL001 medium -> exit code 1
      const incTestsRes = invokeSubprocessCli([
        'check',
        tmpDir,
        '--include-tests',
        '--format',
        'sarif',
      ]);
      assert.equal(incTestsRes.status, 1);
      const sarif = JSON.parse(incTestsRes.stdout) as SarifLog;
      assert.equal(sarif.runs[0].results.length, 2);

      // --include-tests --fail-on none -> exit code 0
      const noneRes = invokeSubprocessCli([
        'check',
        tmpDir,
        '--include-tests',
        '--fail-on=none',
      ]);
      assert.equal(noneRes.status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 on invalid arguments, missing targets, or SYMLINK_ESCAPE_BLOCKED', () => {
    assert.equal(invokeSubprocessCli([]).status, 2);
    assert.equal(invokeSubprocessCli(['invalid-cmd']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', '--bad-flag']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', '--format', 'yaml']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', '--fail-on', 'blocker']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', 'second-target']).status, 2);
    assert.equal(invokeSubprocessCli(['check', './non-existent-path-98765']).status, 2);

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-cli-symroot-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otl-cli-symout-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'ext.ts'), 'export const x = 1;\n', 'utf8');
      fs.symlinkSync(
        outsideDir,
        path.join(rootDir, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      const symRes = invokeSubprocessCli(['check', rootDir]);
      assert.equal(symRes.status, 2);
      assert.ok(symRes.stderr.includes('SYMLINK_ESCAPE_BLOCKED'));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
