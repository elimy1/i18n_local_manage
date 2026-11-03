import fs from 'node:fs'
import path from 'node:path'
import { collectFiles, readSource, summarizeTimings, TEST_FILE_RE, type SourceFile } from './fsx.js'
import { collect } from './parse.js'
import { classify, THRESHOLD } from './detect.js'
import { lineCol } from './fsx.js'
import type { Candidate, Decision, FileTiming, ScanOptions, ScanResult } from './types.js'

export interface ScanFileResult {
  file: SourceFile
  items: Candidate[]
  decisions: Decision[]
  parseOk: boolean
  parseError: string | null
  ms: number
}

/** Analyze one file: parse → pool → classify. Pure; no filesystem writes. */
export function scanSource(file: string, source: string, threshold = THRESHOLD): { items: Candidate[]; decisions: Decision[]; parseOk: boolean; parseError: string | null } {
  const { items, parseOk, parseError } = collect(file, source)
  const decisions: Decision[] = items.map((candidate) => {
    const c = classify(candidate)
    return { candidate, translatable: c.score >= threshold, score: c.score, reasons: c.reasons }
  })
  return { items, decisions, parseOk, parseError }
}

/** Scan a directory tree. Single-threaded on purpose — see docs/05 (D3). */
export function scanProject(opts: ScanOptions): ScanResult {
  const started = Date.now()
  const threshold = opts.threshold ?? THRESHOLD

  const walkStart = Date.now()
  const files = collectFiles(opts.root, {
    include: (rel) => {
      if (TEST_FILE_RE.test(rel)) return false
      return opts.include ? opts.include(rel) : true
    },
    maxFiles: opts.maxFiles,
  })
  const walkMs = Date.now() - walkStart

  let parseMs = 0
  let detectMs = 0
  const perFile: FileTiming[] = []
  const items: Decision[] = []
  const parseErrors: { file: string; error: string }[] = []

  for (const f of files) {
    const fileStart = Date.now()
    let source: string
    try {
      source = readSource(f.abs)
    } catch (e) {
      parseErrors.push({ file: f.rel, error: (e as Error).message })
      continue
    }
    const p0 = Date.now()
    let items0: Candidate[] = []
    let parseOk = true
    let parseError: string | null = null
    try {
      const r = collect(f.rel, source)
      items0 = r.items
      parseOk = r.parseOk
      parseError = r.parseError
    } catch (e) {
      parseOk = false
      parseError = (e as Error).message
    }
    parseMs += Date.now() - p0
    if (!parseOk && parseError) parseErrors.push({ file: f.rel, error: parseError })

    const d0 = Date.now()
    let accepted = 0
    for (const candidate of items0) {
      const c = classify(candidate)
      const decision: Decision = { candidate, translatable: c.score >= threshold, score: c.score, reasons: c.reasons }
      if (decision.translatable) accepted++
      items.push(decision)
    }
    detectMs += Date.now() - d0

    perFile.push({ file: f.rel, bytes: f.size, ms: Date.now() - fileStart, pool: items0.length, accepted })
  }

  const totalMs = Date.now() - started
  const acceptedCount = items.filter((d) => d.translatable).length
  return {
    root: opts.root,
    files: files.length,
    pool: items.length,
    accepted: acceptedCount,
    parseErrors,
    timings: {
      walkMs,
      parseMs,
      detectMs,
      totalMs,
      perFileMs: summarizeTimings(perFile),
      filesPerSec: totalMs > 0 ? Math.round((files.length / totalMs) * 1000) : 0,
    },
    items,
    perFile,
  }
}

/** Convenience for CLI/extension: scan and report progress per file. */
export function scanProjectWithProgress(
  root: string,
  opts: { threshold?: number; maxFiles?: number; onFile?: (done: number, total: number, rel: string) => void; shouldCancel?: () => boolean } = {},
): ScanResult {
  const threshold = opts.threshold ?? THRESHOLD
  const files = collectFiles(root, { maxFiles: opts.maxFiles, include: (rel) => !TEST_FILE_RE.test(rel) })

  const started = Date.now()
  const perFile: FileTiming[] = []
  const items: Decision[] = []
  const parseErrors: { file: string; error: string }[] = []
  let cancelled = false
  let parseMs = 0
  let detectMs = 0
  let i = 0

  for (const f of files) {
    if (opts.shouldCancel?.()) {
      cancelled = true
      break
    }
    const fileStart = Date.now()
    let source: string
    try {
      source = readSource(f.abs)
    } catch (e) {
      parseErrors.push({ file: f.rel, error: (e as Error).message })
      continue
    }
    const p0 = Date.now()
    let pool: Candidate[] = []
    try {
      const r = collect(f.rel, source)
      pool = r.items
      if (!r.parseOk && r.parseError) parseErrors.push({ file: f.rel, error: r.parseError })
    } catch (e) {
      parseErrors.push({ file: f.rel, error: (e as Error).message })
    }
    parseMs += Date.now() - p0

    const d0 = Date.now()
    let accepted = 0
    for (const candidate of pool) {
      const c = classify(candidate)
      const decision: Decision = { candidate, translatable: c.score >= threshold, score: c.score, reasons: c.reasons }
      if (decision.translatable) accepted++
      items.push(decision)
    }
    detectMs += Date.now() - d0
    perFile.push({ file: f.rel, bytes: f.size, ms: Date.now() - fileStart, pool: pool.length, accepted })
    i++
    opts.onFile?.(i, files.length, f.rel)
  }

  const totalMs = Date.now() - started
  return {
    root,
    files: i,
    pool: items.length,
    accepted: items.filter((d) => d.translatable).length,
    parseErrors,
    timings: {
      walkMs: 0,
      parseMs,
      detectMs,
      totalMs,
      perFileMs: summarizeTimings(perFile),
      filesPerSec: totalMs > 0 ? Math.round((i / totalMs) * 1000) : 0,
    },
    items,
    perFile,
  }
}

/** Read a source block (used by the extension to rewrite a single open file). */
export function readFileSource(abs: string): { source: string; lineMap: (pos: number) => number } {
  const source = readSource(abs)
  return { source, lineMap: (pos) => lineCol(source, pos).line }
}

export { path, fs }
