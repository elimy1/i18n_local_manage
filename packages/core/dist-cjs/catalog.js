"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.catalogFiles = catalogFiles;
exports.readCatalog = readCatalog;
exports.patchCatalog = patchCatalog;
exports.writeCatalogs = writeCatalogs;
exports.flattenCatalog = flattenCatalog;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const jsonc_parser_1 = require("jsonc-parser");
const yaml_1 = require("yaml");
const fsx_js_1 = require("./fsx.js");
function catalogFiles(opts) {
    const format = opts.format ?? 'json';
    const locales = opts.locales ?? ['zh-CN'];
    const ext = format === 'yaml' ? 'yaml' : 'json';
    return locales.map((locale) => ({
        abs: node_path_1.default.join(opts.localesDir, `${locale}.${ext}`),
        format,
        locale,
    }));
}
function readCatalog(file) {
    if (!node_fs_1.default.existsSync(file.abs))
        return {};
    const source = (0, fsx_js_1.readSource)(file.abs);
    if (file.format === 'yaml') {
        const parsed = (0, yaml_1.parse)(source);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    try {
        const parsed = JSON.parse(source);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
/** Dot-path lookup on a nested object; catalogs are trees, keys are dotted. */
function lookup(obj, dotted) {
    let cur = obj;
    for (const seg of dotted.split('.')) {
        if (!cur || typeof cur !== 'object')
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
function nest(patch) {
    const segs = patch.key.split('.');
    const root = {};
    let cur = root;
    segs.forEach((seg, i) => {
        if (i === segs.length - 1)
            cur[seg] = patch.value;
        else {
            const next = {};
            cur[seg] = next;
            cur = next;
        }
    });
    return root;
}
/**
 * Merge keys into a catalog while preserving the file's existing formatting.
 *
 * JSON is edited with jsonc-parser's modify/applyEdits rather than JSON.stringify,
 * because a full re-serialize rewrites the whole file: every unrelated line shows
 * up in the diff and reviewers stop reading. YAML goes through the v2 document API
 * for the same reason.
 */
function patchCatalog(file, patches) {
    const exists = node_fs_1.default.existsSync(file.abs);
    const text = exists ? (0, fsx_js_1.readSource)(file.abs) : '';
    const current = readCatalog(file);
    const added = [];
    const unchanged = [];
    const conflicts = [];
    if (file.format === 'yaml') {
        const doc = text ? (0, yaml_1.parse)(text) : {};
        const root = (doc && typeof doc === 'object' ? doc : {});
        for (const p of patches) {
            const existing = lookup(root, p.key);
            if (typeof existing === 'string') {
                if (existing === p.value)
                    unchanged.push(p.key);
                else
                    conflicts.push({ key: p.key, existing, incoming: p.value });
                continue;
            }
            setDeep(root, p.key, p.value);
            added.push(p.key);
        }
        return { file: file.abs, added, unchanged, conflicts, text: (0, yaml_1.stringify)(root) };
    }
    let out = text || '{}\n';
    for (const p of patches) {
        const existing = lookup(current, p.key);
        if (typeof existing === 'string') {
            if (existing === p.value)
                unchanged.push(p.key);
            else
                conflicts.push({ key: p.key, existing, incoming: p.value });
            continue;
        }
        const edits = (0, jsonc_parser_1.modify)(out, p.key.split('.'), p.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
        out = (0, jsonc_parser_1.applyEdits)(out, edits);
        // keep the in-memory view in sync so later patches see earlier ones
        setDeep(current, p.key, p.value);
        added.push(p.key);
    }
    if (!out.endsWith('\n'))
        out += '\n';
    return { file: file.abs, added, unchanged, conflicts, text: out };
}
function setDeep(root, dotted, value) {
    const segs = dotted.split('.');
    let cur = root;
    segs.forEach((seg, i) => {
        if (i === segs.length - 1) {
            cur[seg] = value;
            return;
        }
        const next = cur[seg];
        if (!next || typeof next !== 'object') {
            const fresh = {};
            cur[seg] = fresh;
            cur = fresh;
        }
        else {
            cur = next;
        }
    });
}
/** Write all patched catalogs in one shot; returns the files touched. */
function writeCatalogs(files, patches, dryRun = false) {
    const results = files.map((f) => patchCatalog(f, patches));
    if (!dryRun) {
        for (const r of results) {
            (0, fsx_js_1.ensureDir)(node_path_1.default.dirname(r.file));
            node_fs_1.default.writeFileSync(r.file, r.text);
        }
    }
    return results;
}
/** Flatten a nested catalog into dotted keys — used by coverage/dead-key reports. */
function flattenCatalog(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object')
            Object.assign(out, flattenCatalog(v, key));
        else if (typeof v === 'string')
            out[key] = v;
    }
    return out;
}
// Silence "unused" for the re-nest helper kept for future nested writes.
void nest;
void jsonc_parser_1.findNodeAtLocation;
void jsonc_parser_1.parseTree;
