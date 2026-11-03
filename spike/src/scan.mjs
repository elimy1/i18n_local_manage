#!/usr/bin/env node
import path from 'node:path';
import { collectFiles, readSource, writeJson, lineCol } from './fsx.mjs';
import { collect } from './parse.mjs';
import { classify, THRESHOLD } from './detect.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const root = path.resolve(arg('root', '..'));
const outFile = arg('out', null);
const limit = Number(arg('limit', '0')) || 0;

function scan(rootDir, opts = {}) {
  const t0 = performance.now();
  const files = collectFiles(rootDir, { maxFiles: opts.maxFiles ?? Infinity, include: opts.include });
  const tWalk = performance.now() - t0;

  const items = [];
  const rejected = [];
  const perFile = [];
  const errors = [];
  let tParse = 0;
  let prevAccepted = 0;
  let tDetect = 0;

  for (const f of files) {
    const p0 = performance.now();
    let source;
    try {
      source = readSource(f.abs);
    } catch (e) {
      errors.push({ file: f.rel, error: String(e.message || e) });
      continue;
    }
    let pool = [];
    let parseOk = true;
    let parseError = null;
    try {
      const res = collect(f.rel, source);
      pool = res.items;
      parseOk = res.parseOk;
      parseError = res.parseError;
    } catch (e) {
      parseOk = false;
      parseError = String(e.message || e).slice(0, 200);
      errors.push({ file: f.rel, error: parseError });
    }
    const p1 = performance.now();
    tParse += p1 - p0;

    for (const it of pool) {
      const d = classify(it);
      const rec = {
        file: it.file,
        line: it.line,
        col: it.col,
        kind: it.kind,
        value: it.value ?? source.slice(it.start, it.end),
        raw: source.slice(it.start, it.end),
        start: it.start,
        end: it.end,
        meta: it.meta,
        score: d.score,
        reasons: d.reasons,
      };
      if (d.translatable) items.push(rec);
      else rejected.push(rec);
    }
    const p2 = performance.now();
    tDetect += p2 - p1;
    perFile.push({
      file: f.rel,
      bytes: f.size,
      ms: Number((p2 - p0).toFixed(2)),
      pool: pool.length,
      accepted: items.length - prevAccepted,
      parseOk,
      parseError,
    });
    prevAccepted = items.length;
  }

  const times = perFile.map((p) => p.ms).sort((a, b) => a - b);
  const pct = (q) => (times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))] : 0);

  return {
    root: path.relative(process.cwd(), rootDir) || '.',
    scannedAt: new Date().toISOString(),
    threshold: THRESHOLD,
    files: files.length,
    parseErrors: errors.length,
    pool: items.length + rejected.length,
    accepted: items.length,
    rejected: rejected.length,
    timings: {
      walkMs: Number(tWalk.toFixed(1)),
      parseMs: Number(tParse.toFixed(1)),
      detectMs: Number(tDetect.toFixed(1)),
      totalMs: Number((performance.now() - t0).toFixed(1)),
      perFileMs: { p50: pct(0.5), p95: pct(0.95), max: times.length ? times[times.length - 1] : 0 },
    },
    errors,
    items,
    rejected,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))) {
  const res = scan(root, { maxFiles: limit || Infinity });
  const { items, rejected, ...summary } = res;
  console.log(JSON.stringify(summary, null, 2));
  if (outFile) {
    writeJson(path.resolve(outFile), res);
    console.log(`\nwrote ${path.resolve(outFile)}`);
  }
  if (!outFile && !outFile) {
    for (const it of items.slice(0, 25)) console.log(`  ${it.file}:${it.line} [${it.kind}] score=${it.score} ${JSON.stringify(it.value).slice(0, 70)}`);
  }
}

export { scan };

