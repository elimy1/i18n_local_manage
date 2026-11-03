// D3: bounded worker pool + AST-per-file + incremental NDJSON index.
//   node src/scan-pool.mjs --root ../corpus/vue-vben-admin --out out/vben-pool.json [--workers 4] [--no-cache]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { collectFiles } from './fsx.mjs'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const root = path.resolve(arg('root', '.'))
const out = arg('out', 'out/scan-pool.json')
const workers = Number(arg('workers', Math.max(1, Math.min(4, os.cpus().length - 1))))
const useCache = !args.includes('--no-cache')
const cachePath = path.join(path.dirname(out), `.index-${path.basename(root)}.ndjson`)

const t0 = performance.now()
const files = collectFiles(root)
const walkMs = performance.now() - t0

let peakRss = process.memoryUsage().rss
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss
  if (rss > peakRss) peakRss = rss
}, 40)

// ---- incremental index: (rel, mtime, size) -> previous result -----------------
const cache = new Map()
if (useCache && fs.existsSync(cachePath)) {
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      cache.set(rec.rel, rec)
    } catch { /* a torn tail line is not fatal: it is just a cache miss */ }
  }
}

const pool = []
const items = []
const errors = []
const perFile = []
let done = 0
let next = 0
let finished = false
let reused = 0

const finish = () => {
  if (finished) return
  finished = true
  clearInterval(sampler)
  const totalMs = performance.now() - t0
  perFile.sort((a, b) => a.ms - b.ms)
  const q = (p) => (perFile.length ? perFile[Math.min(perFile.length - 1, Math.floor(perFile.length * p))].ms : 0)

  if (useCache) {
    const lines = [cachePath]
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const body = [...cache.values()].map((r) => JSON.stringify(r)).join('\n') + '\n'
    fs.writeFileSync(lines[0], body)
  }

  const payload = {
    root,
    workers,
    files: files.length,
    reused,
    parsed: files.length - reused,
    pool: perFile.reduce((n, f) => n + (f.pool || 0), 0),
    accepted: items.length,
    parseErrors: errors.length,
    timings: {
      walkMs: Math.round(walkMs * 10) / 10,
      totalMs: Math.round(totalMs * 10) / 10,
      filesPerSec: Math.round(files.length / (totalMs / 1000)),
      perFileMs: { p50: q(0.5), p95: q(0.95), max: q(1) },
    },
    memory: {
      peakRssMB: Math.round(peakRss / 1048576),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      cardsRetained: items.length,
    },
    errors,
    items,
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(payload))
  const { items: _drop, ...summary } = payload
  console.log(JSON.stringify(summary, null, 2))
  console.log(`wrote ${out}`)
  for (const w of pool) w.terminate()
}

const feed = (w) => {
  while (!w.busy && next < files.length) {
    const f = files[next++]
    const rel = typeof f === 'string' ? f : f.rel
    const abs = typeof f === 'string' ? path.join(root, rel) : f.abs
    const hit = cache.get(rel)
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
      reused++
      done++
      perFile.push({ file: rel, bytes: hit.size, ms: 0, pool: hit.pool, accepted: hit.accepted, cached: 1 })
      for (const it of hit.items) items.push(it)
      continue
    }
    w.busy = 1
    w.postMessage({ abs, rel, mtimeMs: f.mtimeMs, size: f.size })
    return
  }
  if (next >= files.length && !pool.some((x) => x.busy) && done === files.length) finish()
}

for (let i = 0; i < workers; i++) {
  const w = new Worker(new URL('./scan-worker.mjs', import.meta.url))
  w.busy = 0
  w.on('message', (msg) => {
    w.busy = 0
    done++
    if (msg.error) errors.push({ file: msg.rel, error: msg.error })
    else {
      perFile.push({ file: msg.rel, bytes: msg.bytes, ms: msg.ms, pool: msg.pool, accepted: msg.accepted })
      if (msg.parseOk === false) errors.push({ file: msg.rel, error: String(msg.parseError).slice(0, 200) })
      for (const it of msg.items) items.push(it)
      cache.set(msg.rel, {
        rel: msg.rel,
        mtimeMs: msg.mtimeMs,
        size: msg.bytes,
        pool: msg.pool,
        accepted: msg.accepted,
        items: msg.items,
      })
    }
    feed(w)
    if (done === files.length) finish()
  })
  w.on('error', (e) => {
    errors.push({ file: '<worker>', error: String(e) })
    w.busy = 0
    done++
    if (done === files.length) finish()
  })
  pool.push(w)
}
for (const w of pool) feed(w)
