#!/usr/bin/env node
/**
 * Labeling workbench.
 *  --dump <scan.json> --sample <n> [--seed 1]  : deterministic stratified sample sheet
 *
 * Outputs a sheet on stdout and (with --todo) a JSON file listing every sampled
 * candidate keyed by `file#start`, so labels can be joined back for evaluation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './fsx.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const scanFile = arg('dump', null);
if (!scanFile) {
  console.error('usage: label.mjs --dump out/x.json --sample 90 --todo labels/x.todo.json');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
const scanPath = path.resolve(scanFile);
const rootDir = path.resolve(path.dirname(scanPath), '..', data.root);

const all = [
  ...data.items.map((i) => ({ ...i, accepted: true })),
  ...data.rejected.map((i) => ({ ...i, accepted: false })),
];

// deterministic RNG (mulberry32)
let seed = Number(arg('seed', '20261103'));
function rnd() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const kindFamily = (k) => (k === 'jsx-sentence' ? 'jsx-text' : k === 'vue-sentence' ? 'vue-text' : k);
const byKind = new Map();
for (const it of all) {
  const f = kindFamily(it.kind);
  if (!byKind.has(f)) byKind.set(f, []);
  byKind.get(f).push(it);
}
const N = Number(arg('sample', '90'));
const families = [...byKind.keys()].sort();
const total = all.length;
const picked = [];
const seenVal = new Set();
for (const f of families) {
  const src = byKind.get(f).slice().sort((a, b) => (a.file + a.start < b.file + b.start ? -1 : 1));
  const want = Math.max(6, Math.round((src.length / total) * N));
  let got = 0;
  for (let i = src.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [src[i], src[j]] = [src[j], src[i]];
  }
  for (const it of src) {
    if (got >= want) break;
    const dv = `${f}|${it.meta?.attrName || it.meta?.propName || ''}|${it.value}`;
    if (seenVal.has(dv)) continue;
    seenVal.add(dv);
    picked.push({ ...it, key: `${it.file}#${it.start}`, family: f });
    got++;
  }
}

picked.sort((a, b) => a.family.localeCompare(b.family) || a.file.localeCompare(b.file) || a.start - b.start);

let n = 0;
let curFamily = '';
for (const it of picked) {
  if (it.family !== curFamily) {
    curFamily = it.family;
    console.log(`\n## ${curFamily}`);
  }
  n++;
  const extra = it.meta?.attrName ? `@${it.meta.attrName}` : it.meta?.propName ? `.${it.meta.propName}` : it.meta?.callee ? `(${it.meta.callee})` : '';
  const val = it.value.length > 84 ? it.value.slice(0, 84) + '…' : it.value;
  console.log(`${String(n).padStart(3)} | ${it.file.split('/').slice(-2).join('/')}:${it.line} | ${extra.padEnd(22)} | ${JSON.stringify(val)}`);
}
console.log(`\n# ${picked.length} sampled from ${total} pool items`);

const todoFile = arg('todo', null);
if (todoFile) {
  writeJson(path.resolve(todoFile), {
    source: path.relative(process.cwd(), scanPath).split(path.sep).join('/'),
    root: data.root,
    sampleSize: picked.length,
    poolSize: total,
    items: picked.map((p, i) => ({ id: i + 1, key: p.key, file: p.file, line: p.line, kind: p.kind, meta: p.meta, value: p.value, score: p.score, accepted: p.accepted })),
  });
  console.log(`wrote ${todoFile}`);
}
