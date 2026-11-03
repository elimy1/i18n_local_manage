// H3: throughput / latency / memory on a real repo.
// usage: node src/bench.mjs ../corpus/vue-vben-admin
import fs from 'node:fs'
import path from 'node:path'
import { collectFiles, readSource } from './fsx.mjs'
import { collect } from './parse.mjs'
import { classify } from './detect.mjs'

const root = process.argv[2] ?? '../corpus/vue-vben-admin'
const runs = Number(process.argv[3] ?? 3)

function pass () {
  const t0 = performance.now()
  const files = collectFiles(root)
  const t1 = performance.now()
  let pool = 0
  let accepted = 0
  const per = []
  for (const f of files) {
    const s = performance.now()
    const src = readSource(f.abs)
    const { items } = collect(f.rel, src)
    for (const it of items) {
      pool++
      if (classify(it).translatable) accepted++
    }
    per.push(performance.now() - s)
  }
  const t2 = performance.now()
  per.sort((a, b) => a - b)
  const q = p => per[Math.min(per.length - 1, Math.floor(per.length * p))]
  return {
    files: files.length,
    pool,
    accepted,
    walkMs: +(t1 - t0).toFixed(1),
    scanMs: +(t2 - t1).toFixed(1),
    totalMs: +(t2 - t0).toFixed(1),
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    max: +per[per.length - 1].toFixed(2),
    filesPerSec: Math.round(files.length / ((t2 - t0) / 1000)),
  }
}

const results = []
for (let i = 0; i < runs; i++) results.push(pass())

// rewrite throughput: time the codemod over the same corpus
const rss = process.memoryUsage()
const summary = {
  root,
  runs: results,
  cold: results[0],
  warmMedian: {
    totalMs: results.slice(1).map(r => r.totalMs).sort((a, b) => a - b)[Math.floor((results.length - 1) / 2)] ?? results[0].totalMs,
  },
  memory: { rssMb: +(rss.rss / 1048576).toFixed(0), heapMb: +(rss.heapUsed / 1048576).toFixed(0) },
}
fs.mkdirSync('out', { recursive: true })
fs.writeFileSync(path.join('out', `bench-${path.basename(root)}.json`), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
