import fs from 'node:fs';
import path from 'node:path';

export const SCRIPT_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs']);
export const VUE_EXT = new Set(['.vue']);

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  'coverage', '.cache', '.turbo', 'vendor', 'public', 'assets', 'static',
  '__snapshots__', '.vscode', '.idea', 'target', '.pnpm-store',
]);

/**
 * Recursively collect source files. Deterministic order (important for benchmarks).
 * @param {string} root
 * @param {{ include?: (rel:string)=>boolean, maxFiles?: number }} [opts]
 */
export function collectFiles(root, opts = {}) {
  const out = [];
  const maxFiles = opts.maxFiles ?? Infinity;
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs = [];
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.storybook') continue;
        subdirs.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SCRIPT_EXT.has(ext) && !VUE_EXT.has(ext)) continue;
      if (e.name.endsWith('.d.ts')) continue;
      if (e.name.endsWith('.min.js')) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (opts.include && !opts.include(rel)) continue;
      const st = fs.statSync(abs);
      out.push({ abs, rel, ext, size: st.size, mtimeMs: st.mtimeMs });
      if (out.length >= maxFiles) break;
    }
    // push in reverse so that traversal stays alphabetical (stack)
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

export function readSource(abs) {
  const buf = fs.readFileSync(abs);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export function lineCol(text, index) {
  let line = 1;
  let last = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { line, col: index - last + 1 };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
