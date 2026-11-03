/**
 * Coverage report as a Markdown document.
 *
 * Rendered into an untitled buffer rather than a webview on purpose: it can be copied
 * into a PR description, pasted into a Slack thread, or diffed — a webview can only be
 * looked at.
 */
import type { CoverageReport, ScanResult } from '@i18n-codemod/core'

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function bar(ratio: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * 20)
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`
}

export function renderReport(
  scan: ScanResult,
  report: CoverageReport,
  catalog: { totalKeys: number; deadKeys: string[] } | null,
): string {
  const lines: string[] = []
  lines.push('# i18n coverage', '')
  lines.push(`Root: \`${scan.root}\``, '')
  lines.push('| metric | value |')
  lines.push('| --- | --- |')
  lines.push(`| files scanned | ${scan.files} |`)
  lines.push(`| files with copy | ${report.filesWithCandidates} |`)
  lines.push(`| copy strings | ${report.candidates} |`)
  lines.push(`| already translated | ${report.extracted} |`)
  lines.push(`| hard-coded | ${report.hardcoded} |`)
  lines.push(`| **coverage** | **${pct(report.coverage)}** |`)
  if (catalog) {
    lines.push(`| catalog keys | ${catalog.totalKeys} |`)
    lines.push(`| dead keys | ${catalog.deadKeys.length} |`)
  }
  lines.push('')
  lines.push(`\`${bar(report.coverage)}\` ${pct(report.coverage)}`, '')

  if (report.byDir.length) {
    lines.push('## By directory', '')
    lines.push('| directory | coverage | hard-coded | total |')
    lines.push('| --- | --- | --- | --- |')
    for (const d of report.byDir.slice(0, 20)) {
      lines.push(`| \`${d.dir}\` | ${pct(d.coverage)} | ${d.hardcoded} | ${d.total} |`)
    }
    lines.push('')
  }

  if (report.byFile.length) {
    lines.push('## Worst files', '')
    lines.push('| file | coverage | hard-coded | total |')
    lines.push('| --- | --- | --- | --- |')
    for (const f of report.byFile.slice(0, 25)) {
      lines.push(`| \`${f.file}\` | ${pct(f.coverage)} | ${f.hardcoded} | ${f.total} |`)
    }
    lines.push('')
  }

  if (catalog && catalog.deadKeys.length) {
    lines.push('## Dead keys', '')
    lines.push('These keys exist in the catalog but no longer appear in source:', '')
    for (const key of catalog.deadKeys.slice(0, 50)) lines.push(`- \`${key}\``)
    if (catalog.deadKeys.length > 50) lines.push(`- … and ${catalog.deadKeys.length - 50} more`)
    lines.push('')
  }

  lines.push('---', '')
  lines.push(`scan: ${scan.timings.totalMs}ms · ${scan.timings.filesPerSec} files/s · p95 ${scan.timings.perFileMs.p95}ms/file`)
  return lines.join('\n')
}
