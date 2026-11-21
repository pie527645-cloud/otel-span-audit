import type { CheckReport } from '../types.js';

export function formatText(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.tool} v${report.version} — scanned ${report.scannedFiles} file(s) in "${report.target}"`
  );

  if (report.findings.length === 0) {
    lines.push('No OpenTelemetry span lifecycle or status issues found.');
    return lines.join('\n');
  }

  lines.push('');
  for (const finding of report.findings) {
    lines.push(
      `[${finding.severity.toUpperCase()}] ${finding.ruleId} ${finding.file}:${finding.line}:${finding.column} — ${finding.message}`
    );
  }

  lines.push('');
  lines.push(
    `Summary: ${report.summary.total} finding(s) (high: ${report.summary.high}, medium: ${report.summary.medium}, low: ${report.summary.low}, info: ${report.summary.info})`
  );

  return lines.join('\n');
}
