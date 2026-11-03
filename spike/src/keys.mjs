// D1: structural + semantic key naming.
//   <namespace>.<scopePath>.<role>.<slug>
// The first three segments are deterministic (file path + AST position); only the
// slug is guessed. Keys are frozen in a registry file so a second run never renames
// anything — renaming keys on every scan is what makes this feature un-shippable.
import fs from 'node:fs'
import path from 'node:path'
import { pinyin } from 'pinyin-pro'

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'is', 'are', 'be', 'in', 'on', 'at', 'it', 'this', 'that'])
const PY_STOP = new Set(['de', 'le', 'ma', 'ba', 'ne', 'a', 'o', 'e'])

const DEFAULT_NS = 'app'
const MAX_KEY = 48

export function scopePath (file) {
  let segs = file.replace(/\\/g, '/').replace(/\.[^./]+$/, '').split('/')
  const src = segs.indexOf('src')
  if (src >= 0) segs = segs.slice(src + 1)
  segs = segs
    .filter(s => s && s !== 'index' && !s.startsWith('_'))
    .map(s => (s === 'views' ? 'pages' : s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
  if (segs.length > 4) segs = segs.slice(-4)
  return segs.join('.')
}

export function roleOf (item) {
  const raw = item.meta?.attrName || item.meta?.propName || ''
  if (raw) return String(raw).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  const callee = item.meta?.callee ?? ''
  if (callee) {
    const last = callee.split('.').filter(Boolean).pop() ?? ''
    if (last) return last.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  }
  if (item.kind === 'string-literal' && item.meta?.varName) return String(item.meta.varName).toLowerCase()
  if (item.kind?.startsWith('jsx') || item.kind?.startsWith('vue')) return 'text'
  return 'text'
}

/** ASCII words first; pinyin when the string is CJK-only; ordinal as last resort. */
export function slugOf (value, seq) {
  const ascii = String(value)
    .replace(/\{v\d+\}/g, ' ')
    .replace(/<\/?\d+\/?>/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w && !/^\d+$/.test(w) && !STOP.has(w))
  if (ascii.length) return ascii.slice(0, 4).join('-').slice(0, 28)

  const han = String(value).replace(/\{v\d+\}/g, '').replace(/<\/?\d+\/?>/g, '')
  const syl = pinyin(han, { toneType: 'none', type: 'array' })
    .map(s => String(s).toLowerCase().replace(/[^a-z]/g, ''))
    .filter(s => s && !PY_STOP.has(s))
  if (syl.length) return syl.slice(0, 4).join('-').slice(0, 28)

  return `t-${String(seq).padStart(4, '0')}`
}

export class KeyRegistry {
  constructor (storePath = 'out/keys.json', ns = DEFAULT_NS) {
    this.path = storePath
    this.ns = ns
    this.map = new Map()
    this.byKey = new Map()
    this.seq = 0
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'))
      for (const [k, v] of Object.entries(raw.keys ?? {})) {
        this.map.set(k, v)
        this.byKey.set(v, k)
      }
      this.seq = raw.seq ?? this.map.size
    }
  }

  /** key is a pure function of (file, role, value) unless it was frozen earlier */
  keyFor (file, item, value) {
    const scope = scopePath(file)
    const role = roleOf(item)
    const id = `${scope}|${role}|${value}`
    const frozen = this.map.get(id)
    if (frozen) return frozen

    const slug = slugOf(value, ++this.seq)
    let key = [this.ns, scope, role, slug].filter(Boolean).join('.')
    if (key.length > MAX_KEY) key = [this.ns, scope, role].join('.')
    let n = 2
    const base = key
    while (this.byKey.has(key) && this.byKey.get(key) !== id) key = `${base}-${n++}`
    this.map.set(id, key)
    this.byKey.set(key, id)
    return key
  }

  /** drop entries that no applied edit referenced (keys from files that failed a gate) */
  prune (used) {
    for (const [id, key] of [...this.map.entries()]) {
      if (!used.has(key)) {
        this.map.delete(id)
        if (this.byKey.get(key) === id) this.byKey.delete(key)
      }
    }
    return this.map.size
  }

  save () {
    fs.mkdirSync(path.dirname(this.path), { recursive: true })
    const keys = {}
    for (const [id, key] of [...this.map.entries()].sort((a, b) => a[1].localeCompare(b[1]))) keys[id] = key
    fs.writeFileSync(this.path, JSON.stringify({ version: 1, ns: this.ns, seq: this.seq, keys }, null, 2) + '\n')
    return this.map.size
  }
}
