import { describe, expect, it } from './_expect.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyFile, planFile, syntaxCheck, veto } from '../src/rewrite.js'
import { KeyRegistry } from '../src/keys.js'
import { collect } from '../src/parse.js'
import type { Candidate } from '../src/types.js'

function registry(): KeyRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'))
  return new KeyRegistry(path.join(dir, 'keys.json'))
}

function itemsOf(file: string, source: string): Candidate[] {
  return collect(file, source).items
}

const tsxFile = 'src/components/Hello.tsx'
const tsxSource = `import React from 'react'

export function Hello({ name }: { name: string }) {
  return (
    <div className="p-4">
      <h1 title="欢迎回来">你好，世界</h1>
      <p>保存成功</p>
    </div>
  )
}
`

describe('react rewrite', () => {
  it('rewrites jsx text and keeps the file parseable', () => {
    const reg = registry()
    const { change, report } = applyFile(tsxFile, itemsOf(tsxFile, tsxSource), tsxSource, reg)
    expect(report.postParseError).toBeUndefined()
    expect(change).not.toBeNull()
    expect(change!.rewritten).toContain('{t("app.components.hello.text.')
    expect(change!.rewritten).toContain('const t = useT()')
    expect(change!.rewritten).toContain("from '@/i18n/react'")
    expect(syntaxCheck(change!.rewritten, tsxFile)).toBeNull()
  })

  it('rewrites sentences with interpolation into a message with values', () => {
    const file = 'src/components/Hi.tsx'
    const src = `export const Hi = ({ name }: { name: string }) => <span>欢迎回来，{name}！</span>\n`
    const { change } = applyFile(file, itemsOf(file, src), src, registry())
    // An expression-bodied component has nowhere to put a hook, so the imperative
    // singleton is used — but the interpolated value must survive the rewrite.
    expect(change!.rewritten).toMatch(/\{(?:i18n\.)?t\("[^"]+", \{ v0: name \}\)\}/)
    expect(change!.rewritten).toContain('huan-ying-hui-lai')
  })

  it('skips tagged templates instead of corrupting them', () => {
    const file = 'src/lib/styles.ts'
    const src = 'const cls = css`\n  color: red;\n`\n'
    const items = itemsOf(file, src)
    const { change } = applyFile(file, items, src, registry())
    // nothing must be rewritten inside the tagged template
    expect(change === null || !change.rewritten.includes('i18n.t(')).toBe(true)
  })

  it('never rewrites console arguments', () => {
    const file = 'src/lib/log.ts'
    const src = "console.warn('网络异常，请稍后重试')\n"
    const items = itemsOf(file, src)
    const { change } = applyFile(file, items, src, registry())
    expect(change === null || !change.rewritten.includes('i18n.t(')).toBe(true)
  })
})

describe('vue rewrite', () => {
  const file = 'src/components/Card.vue'
  const src = `<template>
  <div class="card">
    <h3 title="卡片标题">卡片标题</h3>
    <p>共 {{ count }} 条记录</p>
  </div>
</template>

<script setup lang="ts">
const count = 1
</script>
`

  it('rewrites template text to $t and keeps double quotes valid', () => {
    const { change, report } = applyFile(file, itemsOf(file, src), src, registry())
    expect(report.postParseError).toBeUndefined()
    expect(change!.rewritten).toContain('{{ $t(')
    expect(change!.rewritten).toContain(':title="$t(')
    expect(syntaxCheck(change!.rewritten, file)).toBeNull()
  })
})

describe('guards', () => {
  it('refuses to rewrite when the offset no longer points at a literal', () => {
    const file = 'src/a.ts'
    const src = "const a = 'hello world'\n"
    const [item] = itemsOf(file, src)
    const drifted: Candidate = { ...item!, start: item!.start + 1 }
    // The offset fingerprint gate is what catches this: the value itself looks fine.
    expect(veto(src, drifted)).toBeNull()
    const { change, report } = applyFile(file, [drifted], src, registry())
    expect(change).toBeNull()
    expect(report.skipped.some((s) => s.reason.startsWith('offset-drift'))).toBe(true)
  })

  it('refuses tooling and config files', () => {
    const file = 'scripts/build.ts'
    const src = "export const msg = '构建完成'\n"
    const plan = planFile(file, itemsOf(file, src), src, registry())
    expect(plan.edits).toHaveLength(0)
    expect(plan.skipped[0]!.reason).toBe('script-file')
  })
})

describe('idempotence', () => {
  it('second pass over its own output changes nothing', () => {
    const reg = registry()
    const first = applyFile(tsxFile, itemsOf(tsxFile, tsxSource), tsxSource, reg)
    const rewritten = first.change!.rewritten
    const second = applyFile(tsxFile, itemsOf(tsxFile, rewritten), rewritten, reg)
    // Running apply twice must be a no-op: users do it, and a tool that keeps finding
    // new work in code it just wrote is a tool nobody trusts.
    expect(second.change === null || second.change.rewritten === rewritten).toBe(true)
  })

  it('never injects a duplicate hook import', () => {
    const reg = registry()
    const first = applyFile(tsxFile, itemsOf(tsxFile, tsxSource), tsxSource, reg)
    const rewritten = first.change!.rewritten
    const second = applyFile(tsxFile, itemsOf(tsxFile, rewritten), rewritten, reg)
    const out = second.change?.rewritten ?? rewritten
    expect((out.match(/const t = useT\(\)/g) ?? []).length).toBe(1)
    expect((out.match(/from '@\/i18n\/react'/g) ?? []).length).toBe(1)
  })

  it('does not re-inject useI18n into a Vue script that already has it', () => {
    const file = 'src/components/Card.vue'
    const src = `<template>
  <div class="card">
    <p>共 {{ count }} 条记录</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const count = ref(1)
const label = '加载中'
</script>
`
    const reg = registry()
    const first = applyFile(file, itemsOf(file, src), src, reg)
    const rewritten = first.change!.rewritten
    const second = applyFile(file, itemsOf(file, rewritten), rewritten, reg)
    const out = second.change?.rewritten ?? rewritten
    // A second `import { useI18n }` is a duplicate binding: the file stops compiling.
    expect((out.match(/import \{ useI18n \} from 'vue-i18n'/g) ?? []).length).toBe(1)
    expect((out.match(/const \{ t \} = useI18n\(\)/g) ?? []).length).toBe(1)
  })
})

describe('translation call boundaries', () => {
  it('leaves literals nested inside a t() call alone', () => {
    const file = 'src/lib/msg.ts'
    const src =
      "import { t } from 'x'\nexport const m = (v: number, on: boolean) => t('a.b', { v0: v, v1: on ? '选中' : '未选中' })\n"
    const items = itemsOf(file, src)
    const { change } = applyFile(file, items, src, registry())
    // The nested literals are part of the message above them; pulling them out would
    // nest a t() call inside a t() call and make a second pass find new work.
    expect(change === null || change.rewritten === src).toBe(true)
  })
})
