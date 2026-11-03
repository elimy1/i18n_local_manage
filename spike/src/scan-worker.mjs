// D3: parse in a worker, ship only candidates back. The AST never leaves the worker,
// so the main-thread heap stays flat no matter how many files are scanned.
import { parentPort } from 'node:worker_threads'
import { readSource } from './fsx.mjs'
import { collect } from './parse.mjs'
import { classify } from './detect.mjs'

parentPort.on('message', (msg) => {
  const { abs, rel, mtimeMs, size } = msg
  const t0 = performance.now()
  try {
    const source = readSource(abs)
    const res = collect(rel, source)
    const pool = res.items ?? []
    const items = []
    let accepted = 0
    for (const it of pool) {
      const d = classify(it)
      if (d.translatable) {
        accepted++
        items.push({ ...it, score: d.score, reasons: d.reasons })
      }
    }
    parentPort.postMessage({
      rel,
      mtimeMs,
      bytes: size,
      ms: performance.now() - t0,
      pool: pool.length,
      accepted,
      parseOk: res.parseOk,
      parseError: res.parseError ?? null,
      items,
    })
  } catch (e) {
    parentPort.postMessage({ rel, error: String(e && e.message ? e.message : e) })
  }
})
