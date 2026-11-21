# @pie527645-cloud/otel-span-audit

Static TypeScript and JavaScript AST auditor for OpenTelemetry (`@opentelemetry/api`) span lifecycle leaks and catch-block exception status hygiene.

In OpenTelemetry JS, neither `tracer.startSpan()` nor `tracer.startActiveSpan(name, fn)` automatically ends spans when synchronous blocks exit or `async` callbacks settle, and `span.recordException(err)` only appends an exception event without marking the span status as `SpanStatusCode.ERROR`. `@pie527645-cloud/otel-span-audit` verifies these contracts statically using the TypeScript compiler AST—with zero `@opentelemetry/api` runtime dependencies.

## Quick Start

```bash
npx @pie527645-cloud/otel-span-audit check .
```

Output SARIF v2.1.0 for GitHub Code Scanning or JSON for CI pipelines:

```bash
otel-span-audit check ./src --format sarif --fail-on low
otel-span-audit check . --format json
```

## CLI Reference

```text
otel-span-audit check [path] [--format text|json|sarif] [--fail-on high|medium|low|info|none] [--include-tests]
```

### Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `[path]` | `.` | File or directory to scan |
| `--format <text\|json\|sarif>` | `text` | Output format (`text`, `json`, or SARIF `2.1.0`) |
| `--fail-on <high\|medium\|low\|info\|none>` | `medium` | Minimum severity that causes exit code `1` |
| `--include-tests` | `false` | Scan `test/`, `tests/`, `__tests__/`, `*.test.*`, and `*.spec.*` |
| `-h`, `--help` | — | Print usage information |
| `-v`, `--version` | — | Print package version |

### Exit Codes

| Code | Meaning |
| :--- | :--- |
| `0` | Clean scan, or all findings are strictly below `--fail-on` |
| `1` | One or more findings meet or exceed `--fail-on` |
| `2` | Invalid CLI arguments, missing target path, or blocked symlink/path traversal (`SYMLINK_ESCAPE_BLOCKED`) |

## Rules

Analysis is strictly gated to files importing or requiring `@opentelemetry/api` (ESM named, default, namespace, `import type`, and CommonJS `require('@opentelemetry/api')`). Files that do not import `@opentelemetry/api` always produce `0` findings even if they define custom `.startSpan()`, `.startActiveSpan()`, or `.recordException()` methods.

| Rule ID | Severity | Summary | What It Checks |
| :--- | :--- | :--- | :--- |
| `OTL001` | `medium` | Unended local `startSpan()` | Flags `tracer.startSpan(...)` stored in a local variable or left unassigned when `span.end()` is missing or bypassed by an early `return`, `throw`, `catch` branch, `.then()` without `.finally()`, or `await` outside `try/finally`. Skips spans that escape (returned, passed to helpers, or stored on fields/collections) and never flags borrowed `trace.getActiveSpan()` spans. |
| `OTL002` | `medium` | Unended `startActiveSpan()` callback | Flags inline `startActiveSpan` callbacks across 2-, 3-, and 4-argument overloads (`(name, fn)`, `(name, opts, fn)`, `(name, opts, ctx, fn)`) that omit the `span` parameter, never call `span.end()`, or call `span.end()` only after an unprotected `await` or partial branch. |
| `OTL003` | `low` | `recordException()` without `ERROR` status | Flags `span.recordException(err)` inside `catch` blocks when the same `catch` block omits `span.setStatus({ code: SpanStatusCode.ERROR })` (or numeric `2`), or explicitly sets `SpanStatusCode.OK` (`1`) or `SpanStatusCode.UNSET` (`0`). Skips `catch` blocks where `span` is passed to an error-handling helper (`markSpanError(span, err)`), and ignores `recordException()` outside `catch` blocks. |

### Why `getTracer()` Inside Handlers Is Intentionally Omitted

Unlike database clients or SDK providers, `trace.getTracer(name, version)` in `@opentelemetry/api` delegates to `TracerProvider`, which caches and reuses `Tracer` instances keyed by instrumentation scope. Calling `getTracer()` inside a request handler does not leak sockets, spans, or memory, so flagging per-request `getTracer()` calls creates noisy style warnings rather than catching decidable telemetry defects. `otel-span-audit` focuses strictly on decidable span lifecycle (`OTL001`, `OTL002`) and error status (`OTL003`) invariants.

## Clean Patterns

```ts
import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('billing-service', '1.0.0');

export async function chargeInvoice(invoiceId: string): Promise<void> {
  await tracer.startActiveSpan('billing.charge', async (span) => {
    span.setAttribute('invoice.id', invoiceId);
    try {
      await submitCharge(invoiceId);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

declare function submitCharge(id: string): Promise<void>;
```

## Programmatic API

```ts
import {
  analyzeSourceFile,
  checkProject,
  formatReport,
} from '@pie527645-cloud/otel-span-audit';

const report = checkProject({
  target: './src',
  failOn: 'medium',
  includeTests: false,
});

console.log(formatReport(report, 'json'));

const singleFileFindings = analyzeSourceFile(
  'worker.ts',
  `import { trace } from '@opentelemetry/api';
   const span = trace.getTracer('app').startSpan('job');`
);
```

## Prior Art

- **[`jjti/go-spancheck`](https://github.com/jjti/go-spancheck)**: Go static analyzer—integrated into `golangci-lint`—that checks OpenTelemetry Go spans for unassigned/unended `Start()` spans (`end`) as well as catch/error-return `RecordError` (`record-error`) and `SetStatus(codes.Error, ...)` (`set-status`) invariants. `otel-span-audit` adapts the `jjti/go-spancheck` model directly to TypeScript/JavaScript's `startSpan()`, `startActiveSpan()` async callback semantics, and `catch`-clause `recordException()` / `SpanStatusCode.ERROR` rules.
- **JS/TS Ecosystem Gap**: No ESLint plugin or official Semgrep rule pack currently provides origin-tracked TypeScript/JavaScript AST verification for `@opentelemetry/api` `startSpan` / `startActiveSpan` `try/finally` lifecycles and `recordException` status pairing.

## License

MIT
