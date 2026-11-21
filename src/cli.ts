#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { formatReport } from './formatters/index.js';
import { checkProject } from './index.js';
import { exceedsFailOnThreshold } from './rules.js';
import {
  type FailOnThreshold,
  OtelSpanAuditError,
  type OutputFormat,
  PACKAGE_VERSION,
  UsageError,
} from './types.js';

export interface CliIo {
  stdout(msg: string): void;
  stderr(msg: string): void;
  readonly cwd?: string;
}

const DEFAULT_IO: CliIo = {
  stdout: (msg: string) => {
    process.stdout.write(`${msg}\n`);
  },
  stderr: (msg: string) => {
    process.stderr.write(`${msg}\n`);
  },
};

const VALID_FORMATS = new Set<string>(['text', 'json', 'sarif']);
const VALID_FAIL_ON = new Set<string>(['high', 'medium', 'low', 'info', 'none']);

function buildHelpText(): string {
  return [
    'Usage:',
    '  otel-span-audit check [path] [--format text|json|sarif] [--fail-on high|medium|low|info|none] [--include-tests]',
    '',
    'Options:',
    '  --format <text|json|sarif>              Output format (default: text)',
    '  --fail-on <high|medium|low|info|none>   Exit code 1 threshold (default: medium)',
    '  --include-tests                         Include test directories and *.test.* / *.spec.* files',
    '  -h, --help                              Show help message',
    '  -v, --version                           Show package version',
    '',
    'Exit Codes:',
    '  0  Clean or all findings below --fail-on threshold',
    '  1  At least one finding at or above --fail-on threshold',
    '  2  Invalid CLI arguments, missing target, or blocked path/symlink',
  ].join('\n');
}

interface ParsedCliArgs {
  readonly kind: 'help' | 'version' | 'check';
  readonly target: string;
  readonly format: OutputFormat;
  readonly failOn: FailOnThreshold;
  readonly includeTests: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new UsageError('Missing subcommand. Expected: otel-span-audit check [path]');
  }

  const first = argv[0];
  if (first === '-h' || first === '--help') {
    return {
      kind: 'help',
      target: '.',
      format: 'text',
      failOn: 'medium',
      includeTests: false,
    };
  }
  if (first === '-v' || first === '--version') {
    return {
      kind: 'version',
      target: '.',
      format: 'text',
      failOn: 'medium',
      includeTests: false,
    };
  }

  if (first !== 'check') {
    throw new UsageError(`Unknown subcommand: "${first}". Expected "check".`);
  }

  let target: string | undefined;
  let format: OutputFormat = 'text';
  let failOn: FailOnThreshold = 'medium';
  let includeTests = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      return {
        kind: 'help',
        target: '.',
        format: 'text',
        failOn: 'medium',
        includeTests: false,
      };
    }

    if (arg === '-v' || arg === '--version') {
      return {
        kind: 'version',
        target: '.',
        format: 'text',
        failOn: 'medium',
        includeTests: false,
      };
    }

    if (arg === '--include-tests') {
      includeTests = true;
      continue;
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      const value = arg === '--format' ? argv[++i] : arg.slice('--format='.length);
      if (!value || !VALID_FORMATS.has(value)) {
        throw new UsageError(
          `Invalid --format value: "${value ?? ''}". Expected one of: text, json, sarif.`
        );
      }
      format = value as OutputFormat;
      continue;
    }

    if (arg === '--fail-on' || arg.startsWith('--fail-on=')) {
      const value = arg === '--fail-on' ? argv[++i] : arg.slice('--fail-on='.length);
      if (!value || !VALID_FAIL_ON.has(value)) {
        throw new UsageError(
          `Invalid --fail-on value: "${value ?? ''}". Expected one of: high, medium, low, info, none.`
        );
      }
      failOn = value as FailOnThreshold;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option: "${arg}".`);
    }

    if (target !== undefined) {
      throw new UsageError(
        `Unexpected positional argument: "${arg}". Only a single [path] target is supported.`
      );
    }
    target = arg;
  }

  return {
    kind: 'check',
    target: target ?? '.',
    format,
    failOn,
    includeTests,
  };
}

export function runCli(argv: readonly string[], io: CliIo = DEFAULT_IO): number {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.kind === 'help') {
      io.stdout(buildHelpText());
      return 0;
    }
    if (parsed.kind === 'version') {
      io.stdout(PACKAGE_VERSION);
      return 0;
    }

    const report = checkProject({
      target: parsed.target,
      cwd: io.cwd,
      format: parsed.format,
      failOn: parsed.failOn,
      includeTests: parsed.includeTests,
    });

    io.stdout(formatReport(report, parsed.format));
    return exceedsFailOnThreshold(report.findings, parsed.failOn) ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof OtelSpanAuditError) {
      io.stderr(`Error [${err.code}]: ${err.message}`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error [UNEXPECTED_ERROR]: ${message}`);
    return 2;
  }
}

function isExecutedDirectly(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entryArg).href;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  process.exitCode = runCli(process.argv.slice(2));
}
