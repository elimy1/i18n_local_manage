// Build a locale catalog from codemod records (key -> source value).
// usage: node src/catalog.mjs out/codemod-vben.json
import fs from 'node:fs'
import path from 'node:path'

const [, , cmdPath] = process.argv
const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'))
const tag = cmd.tag ?? 'out'

const entries = new Map()
const conflicts = []
let total = 0
for (const r of cmd.results) {
  for (const rec of r.records ?? []) {
    total++
    if (!rec.key) continue
    const prev = entries.get(rec.key)
    if (prev && prev.value !== rec.value) conflicts.push({ key: rec.key, values: [prev.value, rec.value] })
    else if (!prev) entries.set(rec.key, { value: rec.value, from: `${r.file}:${rec.start}` })
  }
}

const sorted = {}
for (const k of [...entries.keys()].sort()) sorted[k] = entries.get(k).value

const dir = path.join('out', 'locales', tag)
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'zh-CN.json'), JSON.stringify(sorted, null, 2) + '\n')

const placeholders = Object.values(sorted).filter(v => /\{v\d+\}/.test(v)).length
const stats = {
  tag,
  edits: total,
  keys: entries.size,
  conflicts: conflicts.length,
  withPlaceholders: placeholders,
  // a rough proxy for "how much of the UI is now translatable"
  filesRewritten: cmd.results.filter(r => r.applied > 0).length,
  skipReasons: cmd.reasons,
}
fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(stats, null, 2))
console.log(JSON.stringify(stats, null, 2))
if (conflicts.length) console.log('conflicts:', JSON.stringify(conflicts.slice(0, 5), null, 2))
