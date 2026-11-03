#!/usr/bin/env node
/**
 * i18n-codemod CLI.
 *
 * Three verbs, one job each:
 *   scan   — what would change, and how confident are we per string
 *   apply  — perform the rewrite (dry-run by default is *not* the only safety net;
 *            every file passes syntax + offset gates before it is written)
 *   report — coverage and dead keys, with an exit code a CI job can gate on
 *
 * No argument-parsing dependency on purpose: the surface is small, and a CLI that
 * installs 40 packages to read six flags is the sort of thing this project exists
 * to complain about.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  THRESHOLD,
  catalogFiles,
  coverageFromScan,
  exportCatalogs,
  findDeadKeys,
  flattenCatalog,
  readCatalog,
  rewriteProject,
  scanProject,
  type CatalogFile,
  type ScanResult,
} from '@i18n-codemod/core'
import { ADAPTER_IDS, resolveAdapter } from '@i18n-codemod/adapters'

type Command = 'scan' | 'apply' | 'report' | 'help'

interface Options {
  cmd: Command
  root: string
  json: string | null
  jsonOut: boolean
  threshold: number
  keys: string | null
  namespace: string | undefined
  dryRun: boolean
  catalog: string | null
  minCoverage: number | null
  adapter: string
  limit: number | null
  quiet: boolean
}

const USAGE = `i18n-codemod — extract hard-coded strings into i18n catalogs

Usage
  i18n-codemod scan   [root] [options]    list what would be extracted
  i18n-codemod apply  [root] [options]    rewrite sources and freeze keys
  i18n-codemod report [root] [options]    coverage + dead keys (CI gate)

Options
  --threshold <n>     confidence cut-off, default ${THRESHOLD}
  --keys <file>       key registry (apply), default out/keys.json
  --namespace <ns>    key namespace, default app
  --catalog <dir>     locale directory for extracted copy (apply)
  --adapter <id>      framework adapter: auto | ${ADAPTER_IDS.join(' | ')}
  --dry-run           compute everything, write nothing
  --json[=file]       machine-readable output (stdout or the given file)
  --min-coverage <n>  report: exit 1 when coverage% is below n
  --limit <n>         process at most n files
  --quiet             suppress the human summary

Exit codes
  0 ok · 1 gate failed · 2 usage error
`

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    cmd: 'help',
    root: '.',
    json: null,
    jsonOut: false,
    threshold: THRESHOLD,
    keys: null,
    namespace: undefined,
    dryRun: false,
    catalog: null,
    minCoverage: null,
    adapter: 'auto',
    limit: null,
    quiet: false,
  }

  const args = [...argv]
  const first = args[0]
  if (first && !first.startsWith('-')) {
    if (first === 'scan' || first === 'apply' || first === 'report') {
      opts.cmd = first
      args.shift()
    } else if (first === 'help' || first === '--help' || first === '-h') {
      args.shift()
    } else {
      fail(`unknown command: ${first}`)
    }
  }

  while (args.length) {
    const arg = args.shift() as string
    if (!arg.startsWith('-')) {
      opts.root = arg
      continue
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = args.shift()
      if (next === undefined) fail(`missing value for ${flag}`)
      return next
    }
    switch (flag) {
      case '--threshold':
        opts.threshold = Number(value())
        if (!Number.isFinite(opts.threshold)) fail('--threshold must be a number')
        break
      case '--keys':
        opts.keys = value()
        break
      case '--namespace':
        opts.namespace = value()
        break
      case '--catalog':
        opts.catalog = value()
        break
      case '--min-coverage':
        opts.minCoverage = Number(value())
        if (!Number.isFinite(opts.minCoverage)) fail('--min-coverage must be a number')
        break
      case '--adapter':
        opts.adapter = value()
        break
      case '--limit':
        opts.limit = Number(value())
        break
      case '--json':
        opts.jsonOut = true
        opts.json = inline ?? (args[0] && !args[0].startsWith('-') ? (args.shift() as string) : null)
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--quiet':
        opts.quiet = true
        break
      case '--help':
      case '-h':
        opts.cmd = 'help'
        break
      // `-` and unknown flags are ignored rather than fatal: this runs in CI next to
      // other tools that like to append their own flags.
      default:
        break
    }
  }

  return opts
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n\n${USAGE}`)
  process.exit(2)
}

/* ---------------- formatting ---------------- */

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
const ms = (n: number): string => (n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`)
const pad = (s: string, n: number): string => s.padEnd(n, ' ')

function println(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function summary(scan: ScanResult, threshold: number): string[] {
  const out: string[] = []
  out.push(
    `scanned ${scan.files} files in ${ms(scan.timings.totalMs)} (${scan.timings.filesPerSec} files/s, p95 ${scan.timings.perFileMs.p95}ms/file)`,
  )
  const rate = scan.pool ? scan.accepted / scan.pool : 0
  out.push(`candidates ${scan.pool} · accepted ${scan.accepted} (${pct(rate)}) at threshold ${threshold}`)

  const byKind = new Map<string, number>()
  for (const d of scan.items) {
    if (!d.translatable) continue
    byKind.set(d.candidate.kind, (byKind.get(d.candidate.kind) ?? 0) + 1)
  }
  for (const [kind, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${pad(kind, 18)} ${n}`)
  }
  if (scan.parseErrors.length) {
    out.push(`parse errors ${scan.parseErrors.length} (first: ${scan.parseErrors[0]!.file})`)
  }
  return out
}

/**
 * Paths typed on the command line mean what the shell says they mean — resolved against
 * the working directory, like every other CLI. Defaults belong to the project, so those
 * are joined to `root`. Mixing the two rules silently buries output inside the project.
 */
function userPath(value: string | null, root: string, fallback: string): string {
  return value ? path.resolve(value) : path.join(root, fallback)
}

function loadCatalogKeys(opts: Options): CatalogFile | null {
  if (!opts.catalog) return null
  const abs = path.resolve(opts.catalog)
  const format = abs.endsWith('.yaml') || abs.endsWith('.yml') ? 'yaml' : 'json'
  const locale = path.basename(abs).replace(/\.(json|ya?ml)$/, '')
  return { abs, format, locale }
}

/** Scanning nothing is almost always a wrong path, not an empty project. Say so. */
function noSources(opts: Options): number {
  process.stderr.write(
    `error: no source files found under ${path.resolve(opts.root)}\n` +
      `hint: the root is resolved against your working directory\n`,
  )
  return 2
}

/* ---------------- commands ---------------- */

function runScan(opts: Options): number {
  const scan = scanProject({ root: opts.root, threshold: opts.threshold, maxFiles: opts.limit ?? undefined })
  if (!scan.files) return noSources(opts)

  if (opts.jsonOut) {
    emit(opts, {
      command: 'scan',
      root: scan.root,
      files: scan.files,
      pool: scan.pool,
      accepted: scan.accepted,
      timings: scan.timings,
      parseErrors: scan.parseErrors,
      items: scan.items
        .filter((d) => d.translatable)
        .map((d) => ({
          file: d.candidate.file,
          line: d.candidate.line,
          kind: d.candidate.kind,
          value: d.candidate.value,
          score: d.score,
          reasons: d.reasons,
        })),
    })
    return 0
  }

  if (!opts.quiet) {
    for (const line of summary(scan, opts.threshold)) println(line)
  }
  return 0
}

function runApply(opts: Options): number {
  const started = Date.now()
  const scan = scanProject({ root: opts.root, threshold: opts.threshold, maxFiles: opts.limit ?? undefined })
  if (!scan.files) return noSources(opts)
  const keysFile = userPath(opts.keys, opts.root, path.join('out', 'keys.json'))

  let adapter
  try {
    adapter = resolveAdapter(opts.root, opts.adapter)
  } catch (e) {
    // A stack trace is not an error message: tell the user which ids exist.
    fail((e as Error).message)
  }
  const result = rewriteProject(scan.items, {
    root: opts.root,
    threshold: opts.threshold,
    keysFile,
    namespace: opts.namespace,
    dryRun: opts.dryRun,
    aliases: adapter.aliases,
  })

  let catalog: { keys: number; files: string[] } | null = null
  if (opts.catalog && !opts.dryRun) {
    catalog = exportCatalogs(result.files, path.resolve(opts.catalog))
  }

  if (opts.jsonOut) {
    emit(opts, {
      command: 'apply',
      dryRun: opts.dryRun,
      files: result.files.length,
      applied: result.applied,
      skipped: result.skipped,
      skipReasons: result.skipReasons,
      postParseFailures: result.postParseFailures,
      keysFrozen: result.keysFrozen,
      keysLive: result.keysLive,
      catalog,
      ms: Date.now() - started,
    })
    return 0
  }

  if (!opts.quiet) {
    println(`${opts.dryRun ? 'would rewrite' : 'rewrote'} ${result.files.length} file(s) · ${result.applied} edit(s) applied · ${result.skipped} skipped`)
    println(`adapter ${adapter.id} · ${adapter.label}`)
    const reasons = Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1])
    for (const [reason, n] of reasons) println(`  ${pad(reason, 22)} ${n}`)
    println(`keys ${result.keysFrozen} frozen · ${result.keysLive} live`)
    if (result.postParseFailures.length) {
      println(`post-parse failures ${result.postParseFailures.length}:`)
      for (const f of result.postParseFailures.slice(0, 5)) println(`  ${f.file}: ${f.error}`)
    }
    if (catalog) println(`catalog wrote ${catalog.keys} key(s) → ${catalog.files.join(', ')}`)
    if (opts.dryRun) println('dry run: nothing written')
  }
  return result.postParseFailures.length ? 1 : 0
}

function runReport(opts: Options): number {
  const scan = scanProject({ root: opts.root, threshold: opts.threshold, maxFiles: opts.limit ?? undefined })
  if (!scan.files) return noSources(opts)
  const catalog = loadCatalogKeys(opts)
  const catalogKeys = catalog ? Object.keys(flattenCatalog(readCatalog(catalog))) : undefined
  const report = coverageFromScan(scan, { threshold: opts.threshold, catalogKeys })

  if (opts.jsonOut) {
    emit(opts, { command: 'report', ...report })
  } else if (!opts.quiet) {
    println(`coverage ${pct(report.coverage)} — ${report.extracted} extracted / ${report.candidates} copy strings`)
    println(`files with copy ${report.filesWithCandidates} of ${report.files}`)
    if (catalogKeys) println(`catalog ${report.totalKeys} keys · dead ${report.deadKeys}`)
    const worst = report.byFile.slice(0, 8)
    if (worst.length) {
      println('')
      println('worst files')
      for (const f of worst) println(`  ${pad(pct(f.coverage), 7)} ${f.file}  (${f.hardcoded}/${f.total} hard-coded)`)
    }
  }

  if (opts.minCoverage !== null && report.coverage * 100 < opts.minCoverage) {
    process.stderr.write(`coverage ${pct(report.coverage)} is below the required ${opts.minCoverage}%\n`)
    return 1
  }
  return 0
}

function emit(opts: Options, payload: unknown): void {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true })
    fs.writeFileSync(path.resolve(opts.json), text)
    process.stdout.write(`${path.resolve(opts.json)}\n`)
  } else {
    process.stdout.write(text)
  }
}

/* ---------------- entry ---------------- */

const opts = parseArgs(process.argv.slice(2))

switch (opts.cmd) {
  case 'help':
    process.stdout.write(USAGE)
    process.exit(0)
    break
  case 'scan':
    process.exit(runScan(opts))
    break
  case 'apply':
    process.exit(runApply(opts))
    break
  case 'report':
    process.exit(runReport(opts))
    break
}
