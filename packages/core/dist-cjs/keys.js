"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyRegistry = exports.DEFAULT_NS = void 0;
exports.scopePath = scopePath;
exports.roleOf = roleOf;
exports.slugOf = slugOf;
// D1: structural + semantic key naming.
//   <namespace>.<scopePath>.<role>.<slug>
// The first three segments are deterministic (file path + AST position); only the
// slug is guessed. Keys are frozen in a registry file so a second run never renames
// anything — renaming keys on every scan is what makes this feature un-shippable.
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const pinyin_pro_1 = require("pinyin-pro");
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'is', 'are', 'be', 'in', 'on', 'at', 'it', 'this', 'that']);
const PY_STOP = new Set(['de', 'le', 'ma', 'ba', 'ne', 'a', 'o', 'e']);
exports.DEFAULT_NS = 'app';
const MAX_KEY = 48;
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
function scopePath(file) {
    let segs = file.replace(/\\/g, '/').replace(/\.[^./]+$/, '').split('/');
    const src = segs.indexOf('src');
    if (src >= 0)
        segs = segs.slice(src + 1);
    segs = segs
        .filter((s) => s && s !== 'index' && !s.startsWith('_'))
        .map((s) => kebab(s === 'views' ? 'pages' : s));
    if (segs.length > 4)
        segs = segs.slice(-4);
    return segs.join('.');
}
function roleOf(item) {
    const raw = item.meta.attrName || item.meta.propName || '';
    if (raw)
        return kebab(String(raw));
    const callee = item.meta.callee ?? '';
    if (callee) {
        const last = callee.split('.').filter(Boolean).pop() ?? '';
        if (last)
            return kebab(last);
    }
    if (item.kind === 'string-literal' && item.meta.varName)
        return String(item.meta.varName).toLowerCase();
    return 'text';
}
/** ASCII words first; pinyin when the string is CJK-only; ordinal as last resort. */
function slugOf(value, seq) {
    const words = String(value)
        .replace(/\{v\d+\}/g, ' ')
        .replace(/<\/?\d+\/?>/g, ' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w && !/^\d+$/.test(w) && !STOP.has(w));
    if (words.length)
        return words.slice(0, 4).join('-').slice(0, 28);
    const han = String(value).replace(/\{v\d+\}/g, '').replace(/<\/?\d+\/?>/g, '');
    const syl = (0, pinyin_pro_1.pinyin)(han, { toneType: 'none', type: 'array' })
        .map((s) => String(s).toLowerCase().replace(/[^a-z]/g, ''))
        .filter((s) => s && !PY_STOP.has(s));
    if (syl.length)
        return syl.slice(0, 4).join('-').slice(0, 28);
    return `t-${String(seq).padStart(4, '0')}`;
}
class KeyRegistry {
    path;
    ns;
    map = new Map();
    byKey = new Map();
    /** Keys minted during this process; only these may be pruned later. */
    minted = new Set();
    seq = 0;
    constructor(storePath = 'out/keys.json', ns = exports.DEFAULT_NS) {
        this.path = storePath;
        this.ns = ns;
        if (node_fs_1.default.existsSync(storePath)) {
            try {
                const raw = JSON.parse(node_fs_1.default.readFileSync(storePath, 'utf8'));
                for (const [k, v] of Object.entries(raw.keys ?? {})) {
                    this.map.set(k, v);
                    this.byKey.set(v, k);
                }
                this.seq = raw.seq ?? this.map.size;
            }
            catch {
                // A corrupt registry must not take the whole run down: start fresh and
                // let the caller decide (the CLI reports "registry reset").
            }
        }
    }
    get size() {
        return this.map.size;
    }
    /** Key is a pure function of (file, role, value) unless it was frozen earlier. */
    keyFor(file, item, value) {
        const scope = scopePath(file);
        const role = roleOf(item);
        const id = `${scope}|${role}|${value}`;
        const frozen = this.map.get(id);
        if (frozen)
            return frozen;
        const slug = slugOf(value, ++this.seq);
        let key = [this.ns, scope, role, slug].filter(Boolean).join('.');
        if (key.length > MAX_KEY)
            key = [this.ns, scope, role].join('.');
        const base = key;
        let n = 2;
        while (this.byKey.has(key) && this.byKey.get(key) !== id)
            key = `${base}-${n++}`;
        this.map.set(id, key);
        this.byKey.set(key, id);
        this.minted.add(key);
        return key;
    }
    /**
     * Drop keys registered for this run that no applied edit ended up referencing —
     * e.g. a file that failed the post-parse gate after its strings were already named.
     *
     * Only keys minted in *this* process are eligible. A key that was frozen by an earlier
     * run stays even when this run does not touch it: those call sites are still in the
     * source, they simply are not candidates any more, and deleting them would let the next
     * run mint a different key for the same string. That is a silent rename in the catalog.
     */
    prune(used) {
        for (const [id, key] of [...this.map.entries()]) {
            if (!this.minted.has(key))
                continue;
            if (used.has(key))
                continue;
            this.map.delete(id);
            if (this.byKey.get(key) === id)
                this.byKey.delete(key);
        }
        return this.map.size;
    }
    entries() {
        return [...this.map.entries()].map(([id, key]) => ({ id, key }));
    }
    save() {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.path), { recursive: true });
        const keys = {};
        for (const [id, key] of [...this.map.entries()].sort((a, b) => a[1].localeCompare(b[1])))
            keys[id] = key;
        const payload = { version: 1, ns: this.ns, seq: this.seq, keys };
        node_fs_1.default.writeFileSync(this.path, JSON.stringify(payload, null, 2) + '\n');
        return this.map.size;
    }
}
exports.KeyRegistry = KeyRegistry;
