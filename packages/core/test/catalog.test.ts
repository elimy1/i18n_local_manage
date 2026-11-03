import { describe, expect, it } from './_expect.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { catalogFiles, flattenCatalog, patchCatalog, writeCatalogs } from '../src/catalog.js'
import { coverageFromScan, findDeadKeys } from '../src/coverage.js'
import type { ScanResult } from '../src/types.js'

describe('catalog', () => {
  it('preserves existing formatting when adding keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'))
    const file = { abs: path.join(dir, 'zh-CN.json'), format: 'json' as const, locale: 'zh-CN' }
    fs.writeFileSync(file.abs, '{\n  "app": {\n    "existing": "原有文案"\n  }\n}\n')
    const r = patchCatalog(file, [{ key: 'app.pages.user.title', value: '用户管理' }])
    expect(r.added).toEqual(['app.pages.user.title'])
    expect(r.text).toContain('"existing": "原有文案"')
    expect(r.text).toMatch(/"user": \{\s*"title": "用户管理"/)
  })

  it('reports conflicts instead of overwriting translations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'))
    const file = { abs: path.join(dir, 'zh-CN.json'), format: 'json' as const, locale: 'zh-CN' }
    fs.writeFileSync(file.abs, '{"a":{"b":"旧"}}\n')
    const r = patchCatalog(file, [{ key: 'a.b', value: '新' }])
    expect(r.conflicts).toEqual([{ key: 'a.b', existing: '旧', incoming: '新' }])
  })

  it('writes yaml catalogs through the document API', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'))
    const [file] = catalogFiles({ localesDir: dir, format: 'yaml', locales: ['zh-CN'] })
    const out = writeCatalogs([file!], [{ key: 'app.hello', value: '你好' }])
    expect(out[0]!.text).toContain('hello: 你好')
    expect(fs.existsSync(file!.abs)).toBe(true)
    expect(flattenCatalog({ app: { hello: '你好' } })).toEqual({ 'app.hello': '你好' })
  })
})

function fakeScan(): ScanResult {
  const mk = (file: string, value: string, wrapped: boolean, score: number) => ({
    candidate: { id: 'x', file, start: 0, end: 1, line: 1, column: 1, kind: 'jsx-text' as const, value, raw: value, lang: 'tsx' as const, meta: { wrapped } },
    translatable: false,
    score,
    reasons: [],
  })
  const items = [
    mk('src/a.tsx', '保存', false, 0.9),
    mk('src/a.tsx', '取消', true, -0.1),
    mk('src/b.tsx', '删除', false, 0.9),
  ]
  return {
    root: '/r',
    files: 2,
    pool: items.length,
    accepted: 2,
    parseErrors: [],
    timings: { walkMs: 0, parseMs: 0, detectMs: 0, totalMs: 0, perFileMs: { p50: 0, p95: 0, max: 0 }, filesPerSec: 0 },
    items,
    perFile: [],
  }
}

describe('coverage', () => {
  it('counts wrapped copy as extracted, not as noise', () => {
    const report = coverageFromScan(fakeScan())
    expect(report.extracted).toBe(1)
    expect(report.hardcoded).toBe(2)
    expect(report.coverage).toBeCloseTo(1 / 3, 3)
    // Worst-first ordering is deliberate: the dashboard opens on the files that
    // still need work.
    expect(report.byFile[0]!.file).toBe('src/b.tsx')
    expect(report.byFile.find((f) => f.file === 'src/a.tsx')!.coverage).toBeCloseTo(0.5, 3)
  })

  it('reports dead keys', () => {
    expect(findDeadKeys(fakeScan(), ['app.gone.key'])).toEqual(['app.gone.key'])
  })
})
