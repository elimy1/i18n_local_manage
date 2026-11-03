import path from 'node:path'
import { classify, THRESHOLD } from './detect.js'
import type { Candidate, CoverageReport, ScanResult } from './types.js'

const KEY_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z0-9{}_-]+)+$/i

/**
 * Is this candidate user-facing copy, ignoring the "already translated" penalty?
 * A `t('硬编码')` call is *evidence of copy*, not evidence against it — that is
 * exactly what coverage has to measure.
 */
function isCopy(candidate: Candidate, threshold: number): boolean {
  const probe: Candidate = { ...candidate, meta: { ...candidate.meta, wrapped: false } }
  return classify(probe).score >= threshold
}

export interface CoverageOptions {
  threshold?: number
  /** catalog keys, used for dead-key accounting */
  catalogKeys?: Iterable<string>
}

/**
 * Coverage = extracted copy / (extracted + still-hardcoded copy).
 * Counting only "strings that look translatable" and not "strings = copy" is what
 * makes this number defensible in a PR comment.
 */
export function coverageFromScan(scan: ScanResult, opts: CoverageOptions = {}): CoverageReport {
  const threshold = opts.threshold ?? THRESHOLD
  const byFileMap = new Map<string, { total: number; extracted: number; hardcoded: number }>()
  let extracted = 0
  let hardcoded = 0

  for (const d of scan.items) {
    const wrapped = d.candidate.meta.wrapped === true
    // A string already passed to t()/$t() is handled copy by definition. Re-scoring it
    // against the detection heuristics would rank it as "not copy" (the value is now a
    // key, not prose) and a fully migrated project would report 0% coverage.
    if (!wrapped && !isCopy(d.candidate, threshold)) continue
    const isExtracted = wrapped
    const agg = byFileMap.get(d.candidate.file) ?? { total: 0, extracted: 0, hardcoded: 0 }
    agg.total++
    if (isExtracted) {
      agg.extracted++
      extracted++
    } else {
      agg.hardcoded++
      hardcoded++
    }
    byFileMap.set(d.candidate.file, agg)
  }

  const total = extracted + hardcoded
  const byFile = [...byFileMap.entries()]
    .map(([file, v]) => ({ file, ...v, coverage: v.total ? round(v.extracted / v.total) : 0 }))
    .sort((a, b) => a.coverage - b.coverage)

  const dirMap = new Map<string, { total: number; extracted: number; hardcoded: number }>()
  for (const [file, v] of byFileMap) {
    const dir = path.posix.dirname(file) || '.'
    const agg = dirMap.get(dir) ?? { total: 0, extracted: 0, hardcoded: 0 }
    agg.total += v.total
    agg.extracted += v.extracted
    agg.hardcoded += v.hardcoded
    dirMap.set(dir, agg)
  }
  const byDir = [...dirMap.entries()]
    .map(([dir, v]) => ({ dir, ...v, coverage: v.total ? round(v.extracted / v.total) : 0 }))
    .sort((a, b) => a.coverage - b.coverage)

  const catalogKeys = opts.catalogKeys ? new Set(opts.catalogKeys) : undefined
  const used = new Set<string>()
  for (const d of scan.items) {
    if (!d.candidate.meta.wrapped) continue
    const v = (d.candidate.value ?? '').trim()
    if (catalogKeys?.has(v)) used.add(v)
  }

  return {
    root: scan.root,
    files: scan.files,
    filesWithCandidates: byFileMap.size,
    candidates: total,
    extracted,
    hardcoded,
    coverage: total ? round(extracted / total) : 1,
    deadKeys: catalogKeys ? catalogKeys.size - used.size : 0,
    totalKeys: catalogKeys?.size ?? 0,
    byFile,
    byDir,
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Catalog keys that no longer appear anywhere — the "dead key" half of maintenance. */
export function findDeadKeys(scan: ScanResult, catalogKeys: Iterable<string>): string[] {
  const seen = new Set<string>()
  for (const d of scan.items) {
    const v = (d.candidate.value ?? '').trim()
    if (KEY_SHAPE.test(v)) seen.add(v)
    if (d.candidate.meta.wrapped) seen.add(v)
  }
  const dead: string[] = []
  for (const k of catalogKeys) if (!seen.has(k)) dead.push(k)
  return dead.sort()
}
