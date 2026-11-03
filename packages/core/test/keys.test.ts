import { describe, expect, it } from './_expect.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KeyRegistry, roleOf, scopePath, slugOf } from '../src/keys.js'
import type { Candidate } from '../src/types.js'

const item = (kind: string, meta: Record<string, unknown> = {}): Candidate => ({
  id: 'x',
  file: 'src/views/user/Profile.vue',
  start: 0,
  end: 1,
  line: 1,
  column: 1,
  kind: kind as Candidate['kind'],
  value: 'v',
  raw: 'v',
  lang: 'vue',
  meta,
})

describe('scopePath', () => {
  it('drops src, index and underscore segments', () => {
    expect(scopePath('src/index.ts')).toBe('')
    expect(scopePath('src/views/user/Profile.vue')).toBe('pages.user.profile')
    expect(scopePath('src/components/_internal/Button.tsx')).toBe('components.button')
    expect(scopePath('src/a/b/c/d/e/f.ts')).toBe('c.d.e.f')
  })
})

describe('roleOf', () => {
  it('prefers attribute, then callee, then text', () => {
    expect(roleOf(item('jsx-attr', { attrName: 'placeholder' }))).toBe('placeholder')
    expect(roleOf(item('call-arg', { callee: 'message.success' }))).toBe('success')
    expect(roleOf(item('jsx-text'))).toBe('text')
  })
})

describe('slugOf', () => {
  it('uses ascii words, then pinyin, then ordinal', () => {
    expect(slugOf('Delete workspace', 1)).toBe('delete-workspace')
    expect(slugOf('请输入用户名', 1)).toBe('qing-shu-ru-yong')
    expect(slugOf('保存', 7)).toBe('bao-cun')
    expect(slugOf('!!!', 12)).toBe('t-0012')
  })
})

describe('KeyRegistry', () => {
  it('freezes keys across runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'))
    const file = path.join(dir, 'keys.json')
    const r1 = new KeyRegistry(file, 'app')
    const k1 = r1.keyFor('src/views/user/Profile.vue', item('jsx-text'), '保存成功')
    r1.save()

    const r2 = new KeyRegistry(file, 'app')
    const k2 = r2.keyFor('src/views/user/Profile.vue', item('jsx-text'), '保存成功')
    expect(k2).toBe(k1)
    expect(k1.startsWith('app.pages.user.profile.text.')).toBe(true)
  })

  it('never emits content hashes and prunes unreferenced keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'))
    const r = new KeyRegistry(path.join(dir, 'k.json'))
    const a = r.keyFor('src/a/B.vue', item('jsx-text'), '请输入')
    const b = r.keyFor('src/a/B.vue', item('jsx-text'), '请选择')
    expect(a).not.toMatch(/[0-9a-f]{6}$/)
    expect(r.prune(new Set([a]))).toBe(1)
    expect(r.entries().map((e) => e.key)).toEqual([a])
    expect(b).not.toBe(a)
  })
})
