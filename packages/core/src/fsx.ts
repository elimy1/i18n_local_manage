import fs from 'node:fs'
import path from 'node:path'
import type { FileTiming } from './types.js'

export const SCRIPT_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs'])
export const VUE_EXT = new Set(['.vue'])

/** Files that are never worth scanning: fixtures, generated code, tests. */
export const TEST_FILE_RE = /(^|\/)(__tests__|__mocks__|e2e|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  'coverage', '.cache', '.turbo', 'vendor', 'public', 'assets', 'static',
  '__snapshots__', '.vscode', '.idea', 'target', '.pnpm-store',
])

export interface SourceFile {
  abs: string
  rel: string
  ext: string
  size: number
  mtimeMs: number
}

export interface CollectOptions {
  include?: (rel: string) => boolean
  maxFiles?: number
  excludeDirs?: Iterable<string>
}

/**
 * Recursively collect source files in deterministic (alphabetical) order.
 * Ordering matters: benchmark numbers and key generation must be reproducible.
 */
export function collectFiles(root: string, opts: CollectOptions = {}): SourceFile[] {
  const out: SourceFile[] = []
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY
  const exclude = opts.excludeDirs ? new Set(opts.excludeDirs) : DEFAULT_EXCLUDE_DIRS
  const stack: string[] = [root]

  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const subdirs: string[] = []
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (exclude.has(e.name)) continue
        if (e.name.startsWith('.') && e.name !== '.storybook') continue
        subdirs.push(abs)
        continue
      }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (!SCRIPT_EXT.has(ext) && !VUE_EXT.has(ext)) continue
      if (e.name.endsWith('.d.ts') || e.name.endsWith('.min.js')) continue
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (opts.include && !opts.include(rel)) continue
      const st = fs.statSync(abs)
      out.push({ abs, rel, ext, size: st.size, mtimeMs: st.mtimeMs })
      if (out.length >= maxFiles) break
    }
    // Push in reverse so traversal stays alphabetical.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i] as string)
  }

  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/** Read a source file, stripping the UTF-8 BOM so offsets match the parser. */
export function readSource(abs: string): string {
  return stripBom(fs.readFileSync(abs).toString('utf8'))
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function detectBom(buf: Buffer): boolean {
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

export function detectCrlf(buf: Buffer): boolean {
  return buf.includes(Buffer.from('\r\n'))
}

export function lineCol(text: string, index: number): { line: number; col: number } {
  let line = 1
  let last = 0
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      last = i + 1
    }
  }
  return { line, col: index - last + 1 }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] as number
}

export function summarizeTimings(perFile: FileTiming[]): { p50: number; p95: number; max: number } {
  const ms = perFile.map((f) => f.ms)
  return {
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    max: ms.length ? Math.max(...ms) : 0,
  }
}
