// Build a reviewable sample of rewrites + automated soundness checks.
// usage: node src/review.mjs out/codemod-adp.json ../corpus/ant-design-pro out/rewritten/adp [n]
import fs from 'node:fs'
import path from 'node:path'
import { readSource, lineCol } from './fsx.mjs'

const [, , cmdPath, rootDir, destDir, nArg] = process.argv
const N = Number(nArg || 30)
const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'))

const recs = []
for (const r of cmd.results) {
  for (const rec of r.records ?? []) recs.push({ file: r.file, ...rec })
}

/* deterministic sample spread over files */
function mulberry32 (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(7)
const byFile = new Map()
for (const rec of recs) {
  if (!byFile.has(rec.file)) byFile.set(rec.file, [])
  byFile.get(rec.file).push(rec)
}
const picked = []
for (const f of byFile.keys()) picked.push(byFile.get(f)[0])
const rest = recs.filter(r => !picked.includes(r))
while (picked.length < N && rest.length) picked.push(rest.splice(Math.floor(rnd() * rest.length), 1)[0])
const sample = picked.slice(0, N)

/* ---- automated soundness checks over every rewritten file ---- */
const files = cmd.results.filter(r => r.applied > 0).map(r => r.file)
const missingScope = []
let injected = 0
for (const f of files) {
  const src = readSource(path.join(destDir, f))
  if (/from '@\/i18n/.test(src)) injected++
  const decl = /(const|let)\s*\{[^}]*\bt\b[^}]*\}\s*=|(const|let)\s+t\s*=|function\s+t\s*\(/.test(src)
  const bare = [...src.matchAll(/(^|[^.\w$])t\s*\(/g)].filter(m => !/\$t\(/.test(src.slice(Math.max(0, m.index - 2), m.index + 3)))
  if (bare.length && !decl && !f.endsWith('.vue')) missingScope.push(f)
}

const L = []
L.push(`# 改写抽样审查 · ${cmd.tag}`, '')
L.push(`- 改写文件: ${files.length} / applied ${cmd.applied}`)
L.push(`- 注入 import 的文件: ${injected}`)
L.push(`- 作用域可疑(裸 t 无声明): ${missingScope.length}${missingScope.length ? ' -> ' + missingScope.slice(0, 5).join(', ') : ''}`)
L.push('', '## 逐条样本', '')
let i = 0
for (const rec of sample) {
  i++
  const origSrc = readSource(path.join(rootDir, rec.file))
  const nextSrc = readSource(path.join(destDir, rec.file))
  const { line } = lineCol(origSrc, rec.start)
  const oc = origSrc.split(/\r?\n/)
  const nc = nextSrc.split(/\r?\n/)
  const nl = nc.findIndex(l => l.includes(`"${rec.key}"`))
  L.push(`### ${i}. ${rec.file}:${line} [${rec.kind}]`)
  L.push('```diff')
  L.push(`- ${(oc[line - 1] ?? '').trim()}`)
  L.push(`+ ${nl >= 0 ? nc[nl].trim() : '<<not found>>'}`)
  L.push('```')
  L.push(`key=\`${rec.key}\` value=\`${rec.value.replace(/\n/g, '\\n')}\``)
  L.push('')
}
const out = `out/review-${cmd.tag}.md`
fs.writeFileSync(out, L.join('\n'))
console.log(`wrote ${out}: ${sample.length} samples, ${files.length} files, injected=${injected}, scopeSuspects=${missingScope.length}`)
