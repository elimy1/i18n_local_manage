import fs from 'node:fs'
import path from 'node:path'

const LABELS = 'labels'
const OUT = 'out'
const DATASETS = ['vben', 'adp', 'chat']

const TEST_RE = /(^|\/)(__tests__|__mocks__|e2e|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i

function load (name) {
  const todo = JSON.parse(fs.readFileSync(path.join(LABELS, `${name}.todo.json`), 'utf8')).items
  const labels = JSON.parse(fs.readFileSync(path.join(LABELS, `${name}.labels.json`), 'utf8'))
  const positive = new Set(labels.positive)
  return todo.map(it => ({ ...it, truth: positive.has(it.id) }))
}

function stats (rows, t) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const r of rows) {
    const pred = r.score >= t
    if (pred && r.truth) tp++
    else if (pred && !r.truth) fp++
    else if (!pred && r.truth) fn++
    else tn++
  }
  const p = tp + fp === 0 ? 1 : tp / (tp + fp)
  const r = tp + fn === 0 ? 1 : tp / (tp + fn)
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r)
  return { tp, fp, fn, tn, precision: p, recall: r, f1 }
}

const fmt = (x) => (x * 100).toFixed(1).padStart(5) + '%'

const data = {}
for (const name of DATASETS) data[name] = load(name)

console.log('== labelled sample composition ==')
for (const name of DATASETS) {
  const rows = data[name]
  const pos = rows.filter(r => r.truth).length
  const testRows = rows.filter(r => TEST_RE.test(r.file))
  console.log(`${name.padEnd(5)} sampled=${String(rows.length).padStart(3)} positive=${String(pos).padStart(3)} positiveRate=${fmt(pos / rows.length)} testFileRows=${testRows.length}`)
}

const THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8]
const sweep = {}

console.log('\n== recall / precision as the score threshold moves (all sampled rows) ==')
console.log('threshold | ' + DATASETS.map(d => `${d.padEnd(20)}`).join(' | ') + ' | pooled')
for (const t of THRESHOLDS) {
  const cells = []
  let agg = { tp: 0, fp: 0, fn: 0, tn: 0 }
  for (const name of DATASETS) {
    const s = stats(data[name], t)
    agg.tp += s.tp; agg.fp += s.fp; agg.fn += s.fn; agg.tn += s.tn
    cells.push(`P ${fmt(s.precision)} R ${fmt(s.recall)}`)
    ;(sweep[name] ??= []).push({ t, ...s })
  }
  const p = agg.tp + agg.fp === 0 ? 1 : agg.tp / (agg.tp + agg.fp)
  const r = agg.tp + agg.fn === 0 ? 1 : agg.tp / (agg.tp + agg.fn)
  console.log(`${t.toFixed(2)}      | ${cells.join(' | ')} | P ${fmt(p)} R ${fmt(r)}`)
}

const T = 0.5
console.log(`\n== headline @ threshold ${T} ==`)
let poolAgg = { tp: 0, fp: 0, fn: 0, tn: 0 }
let cleanAgg = { tp: 0, fp: 0, fn: 0, tn: 0 }
for (const name of DATASETS) {
  const rows = data[name]
  const all = stats(rows, T)
  const clean = stats(rows.filter(r => !TEST_RE.test(r.file)), T)
  for (const k of ['tp', 'fp', 'fn', 'tn']) { poolAgg[k] += all[k]; cleanAgg[k] += clean[k] }
  console.log(`${name.padEnd(5)} all:   TP ${all.tp} FP ${all.fp} FN ${all.fn} TN ${all.tn}  P ${fmt(all.precision)} R ${fmt(all.recall)} F1 ${fmt(all.f1)}`)
  console.log(`${name.padEnd(5)} clean: TP ${clean.tp} FP ${clean.fp} FN ${clean.fn} TN ${clean.tn}  P ${fmt(clean.precision)} R ${fmt(clean.recall)} F1 ${fmt(clean.f1)}`)
}
const pa = ['tp', 'fp', 'fn', 'tn'].reduce((o, k) => ({ ...o, [k]: poolAgg[k] }), {})
const P = poolAgg.tp / (poolAgg.tp + poolAgg.fp), R = poolAgg.tp / (poolAgg.tp + poolAgg.fn)
console.log(`POOLED all:   P ${fmt(P)} R ${fmt(R)} F1 ${fmt((2 * P * R) / (P + R))}`)
const P2 = cleanAgg.tp / (cleanAgg.tp + cleanAgg.fp), R2 = cleanAgg.tp / (cleanAgg.tp + cleanAgg.fn)
console.log(`POOLED clean: P ${fmt(P2)} R ${fmt(R2)} F1 ${fmt((2 * P2 * R2) / (P2 + R2))}`)

console.log(`\n== by candidate kind @ ${T} (pooled) ==`)
const kinds = new Map()
for (const name of DATASETS) for (const r of data[name]) {
  const k = r.kind
  const e = kinds.get(k) ?? { tp: 0, fp: 0, fn: 0, tn: 0 }
  const pred = r.score >= T
  if (pred && r.truth) e.tp++
  else if (pred && !r.truth) e.fp++
  else if (!pred && r.truth) e.fn++
  else e.tn++
  kinds.set(k, e)
}
for (const [k, e] of [...kinds].sort((a, b) => (b[1].tp + b[1].fp) - (a[1].tp + a[1].fp))) {
  const p = e.tp + e.fp === 0 ? 1 : e.tp / (e.tp + e.fp)
  const r = e.tp + e.fn === 0 ? 1 : e.tp / (e.tp + e.fn)
  console.log(`${k.padEnd(18)} n=${String(e.tp + e.fp + e.fn + e.tn).padStart(3)} P ${fmt(p)} R ${fmt(r)}  (tp ${e.tp} fp ${e.fp} fn ${e.fn})`)
}

const reasons = {}
for (const name of DATASETS) for (const r of data[name]) {
  if (r.truth && r.score < T) {
    const key = (r.reasons || []).filter(x => x.startsWith('-')).join(' ') || '(no negative reason)'
    reasons[key] = (reasons[key] ?? 0) + 1
  }
}
console.log('\n== why true positives were missed (negative reasons on positives) ==')
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}  ${k}`)

fs.writeFileSync(path.join(OUT, 'eval.json'), JSON.stringify({ thresholds: THRESHOLDS, sweep, pooled: { all: poolAgg, clean: cleanAgg } }, null, 2))
console.log(`\nwrote ${path.join(OUT, 'eval.json')}`)
