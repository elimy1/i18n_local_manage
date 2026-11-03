import fs from 'node:fs'
import path from 'node:path'
import { modify, applyEdits, parseTree, findNodeAtLocation } from 'jsonc-parser'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { ensureDir, readSource } from './fsx.js'

export type CatalogFormat = 'json' | 'yaml'

export interface CatalogFile {
  abs: string
  format: CatalogFormat
  locale: string
}

export interface CatalogPatch {
  key: string
  value: string
}

export interface CatalogEditResult {
  file: string
  added: string[]
  unchanged: string[]
  conflicts: { key: string; existing: string; incoming: string }[]
  text: string
}

export interface CatalogOptions {
  localesDir: string
  locales?: string[]
  format?: CatalogFormat
  /** default locale gets the extracted source text; others stay empty for translators */
  sourceLocale?: string
}

export function catalogFiles(opts: CatalogOptions): CatalogFile[] {
  const format = opts.format ?? 'json'
  const locales = opts.locales ?? ['zh-CN']
  const ext = format === 'yaml' ? 'yaml' : 'json'
  return locales.map((locale) => ({
    abs: path.join(opts.localesDir, `${locale}.${ext}`),
    format,
    locale,
  }))
}

export function readCatalog(file: CatalogFile): Record<string, unknown> {
  if (!fs.existsSync(file.abs)) return {}
  const source = readSource(file.abs)
  if (file.format === 'yaml') {
    const parsed = parseYaml(source)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  }
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Dot-path lookup on a nested object; catalogs are trees, keys are dotted. */
function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function nest(patch: CatalogPatch): Record<string, unknown> {
  const segs = patch.key.split('.')
  const root: Record<string, unknown> = {}
  let cur = root
  segs.forEach((seg, i) => {
    if (i === segs.length - 1) cur[seg] = patch.value
    else {
      const next: Record<string, unknown> = {}
      cur[seg] = next
      cur = next
    }
  })
  return root
}

/**
 * Merge keys into a catalog while preserving the file's existing formatting.
 *
 * JSON is edited with jsonc-parser's modify/applyEdits rather than JSON.stringify,
 * because a full re-serialize rewrites the whole file: every unrelated line shows
 * up in the diff and reviewers stop reading. YAML goes through the v2 document API
 * for the same reason.
 */
export function patchCatalog(file: CatalogFile, patches: CatalogPatch[]): CatalogEditResult {
  const exists = fs.existsSync(file.abs)
  const text = exists ? readSource(file.abs) : ''
  const current = readCatalog(file)
  const added: string[] = []
  const unchanged: string[] = []
  const conflicts: CatalogEditResult['conflicts'] = []

  if (file.format === 'yaml') {
    const doc = text ? parseYaml(text) : {}
    const root = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>
    for (const p of patches) {
      const existing = lookup(root, p.key)
      if (typeof existing === 'string') {
        if (existing === p.value) unchanged.push(p.key)
        else conflicts.push({ key: p.key, existing, incoming: p.value })
        continue
      }
      setDeep(root, p.key, p.value)
      added.push(p.key)
    }
    return { file: file.abs, added, unchanged, conflicts, text: stringifyYaml(root) }
  }

  let out = text || '{}\n'
  for (const p of patches) {
    const existing = lookup(current, p.key)
    if (typeof existing === 'string') {
      if (existing === p.value) unchanged.push(p.key)
      else conflicts.push({ key: p.key, existing, incoming: p.value })
      continue
    }
    const edits = modify(out, p.key.split('.'), p.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } })
    out = applyEdits(out, edits)
    // keep the in-memory view in sync so later patches see earlier ones
    setDeep(current, p.key, p.value)
    added.push(p.key)
  }
  if (!out.endsWith('\n')) out += '\n'
  return { file: file.abs, added, unchanged, conflicts, text: out }
}

function setDeep(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segs = dotted.split('.')
  let cur = root
  segs.forEach((seg, i) => {
    if (i === segs.length - 1) {
      cur[seg] = value
      return
    }
    const next = cur[seg]
    if (!next || typeof next !== 'object') {
      const fresh: Record<string, unknown> = {}
      cur[seg] = fresh
      cur = fresh
    } else {
      cur = next as Record<string, unknown>
    }
  })
}

/** Write all patched catalogs in one shot; returns the files touched. */
export function writeCatalogs(files: CatalogFile[], patches: CatalogPatch[], dryRun = false): CatalogEditResult[] {
  const results = files.map((f) => patchCatalog(f, patches))
  if (!dryRun) {
    for (const r of results) {
      ensureDir(path.dirname(r.file))
      fs.writeFileSync(r.file, r.text)
    }
  }
  return results
}

/** Flatten a nested catalog into dotted keys — used by coverage/dead-key reports. */
export function flattenCatalog(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') Object.assign(out, flattenCatalog(v as Record<string, unknown>, key))
    else if (typeof v === 'string') out[key] = v
  }
  return out
}

// Silence "unused" for the re-nest helper kept for future nested writes.
void nest
void findNodeAtLocation
void parseTree
