// Heuristic audit over ALL rewrites: flags the defect classes found during manual review.
// usage: node src/audit.mjs out/codemod-vben.json out/codemod-adp.json
import fs from 'node:fs'

const files = process.argv.slice(2)
let all = []
for (const f of files) {
  const cmd = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const r of cmd.results) for (const rec of r.records ?? []) all.push({ tag: cmd.tag, file: r.file, ...rec })
}

const flags = { codeLeak: [], fragment: [], doubleWrap: [], hashKey: [] }
// placeholders that are legitimate: {vN} interpolations and <tag> element slots
const stripPlaceholders = s => s.replace(/\{v\d+\}/g, '').replace(/<\/?[a-zA-Z][\w-]*>/g, '').replace(/<\/?\d+\/?>/g, '')
for (const rec of all) {
  const v = rec.value ?? ''
  const bare = stripPlaceholders(v)
  if (/[{}[\];"=<>]|\bpx\b|rgba?|\.ant-|hljs/i.test(bare)) flags.codeLeak.push(rec)
  if (/^[万月个次条元岁天秒分日周年份位张]$/.test(v.trim())) flags.fragment.push(rec)
  if (/\$t\(|\bt\(/.test(v)) flags.doubleWrap.push(rec)
  if (/^auto\.c[0-9a-f]{6}$/.test(rec.key ?? '')) flags.hashKey.push(rec)
}

const n = all.length
const pct = x => ((x / n) * 100).toFixed(2)
console.log(`total rewrites: ${n}`)
for (const [k, v] of Object.entries(flags)) console.log(`${k.padEnd(10)} ${String(v.length).padStart(4)}  (${pct(v.length)}%)`)
for (const [k, v] of Object.entries(flags)) {
  if (!v.length) continue
  console.log(`\n## ${k}`)
  for (const r of v.slice(0, 12)) console.log(`- [${r.tag}] ${r.file} :: ${JSON.stringify(r.value)} -> ${r.key}`)
}
const hard = flags.codeLeak.length + flags.doubleWrap.length + flags.fragment.length
console.log(`\nhard-defect candidates: ${hard} / ${n} = ${pct(hard)}%`)
