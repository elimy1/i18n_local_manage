"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.coverageFromScan = coverageFromScan;
exports.findDeadKeys = findDeadKeys;
const node_path_1 = __importDefault(require("node:path"));
const detect_js_1 = require("./detect.js");
const KEY_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z0-9{}_-]+)+$/i;
/**
 * Is this candidate user-facing copy, ignoring the "already translated" penalty?
 * A `t('硬编码')` call is *evidence of copy*, not evidence against it — that is
 * exactly what coverage has to measure.
 */
function isCopy(candidate, threshold) {
    const probe = { ...candidate, meta: { ...candidate.meta, wrapped: false } };
    return (0, detect_js_1.classify)(probe).score >= threshold;
}
/**
 * Coverage = extracted copy / (extracted + still-hardcoded copy).
 * Counting only "strings that look translatable" and not "strings = copy" is what
 * makes this number defensible in a PR comment.
 */
function coverageFromScan(scan, opts = {}) {
    const threshold = opts.threshold ?? detect_js_1.THRESHOLD;
    const byFileMap = new Map();
    let extracted = 0;
    let hardcoded = 0;
    for (const d of scan.items) {
        const wrapped = d.candidate.meta.wrapped === true;
        // A string already passed to t()/$t() is handled copy by definition. Re-scoring it
        // against the detection heuristics would rank it as "not copy" (the value is now a
        // key, not prose) and a fully migrated project would report 0% coverage.
        if (!wrapped && !isCopy(d.candidate, threshold))
            continue;
        const isExtracted = wrapped;
        const agg = byFileMap.get(d.candidate.file) ?? { total: 0, extracted: 0, hardcoded: 0 };
        agg.total++;
        if (isExtracted) {
            agg.extracted++;
            extracted++;
        }
        else {
            agg.hardcoded++;
            hardcoded++;
        }
        byFileMap.set(d.candidate.file, agg);
    }
    const total = extracted + hardcoded;
    const byFile = [...byFileMap.entries()]
        .map(([file, v]) => ({ file, ...v, coverage: v.total ? round(v.extracted / v.total) : 0 }))
        .sort((a, b) => a.coverage - b.coverage);
    const dirMap = new Map();
    for (const [file, v] of byFileMap) {
        const dir = node_path_1.default.posix.dirname(file) || '.';
        const agg = dirMap.get(dir) ?? { total: 0, extracted: 0, hardcoded: 0 };
        agg.total += v.total;
        agg.extracted += v.extracted;
        agg.hardcoded += v.hardcoded;
        dirMap.set(dir, agg);
    }
    const byDir = [...dirMap.entries()]
        .map(([dir, v]) => ({ dir, ...v, coverage: v.total ? round(v.extracted / v.total) : 0 }))
        .sort((a, b) => a.coverage - b.coverage);
    const catalogKeys = opts.catalogKeys ? new Set(opts.catalogKeys) : undefined;
    const used = new Set();
    for (const d of scan.items) {
        if (!d.candidate.meta.wrapped)
            continue;
        const v = (d.candidate.value ?? '').trim();
        if (catalogKeys?.has(v))
            used.add(v);
    }
    return {
        root: scan.root,
        files: scan.files,
        filesWithCandidates: byFileMap.size,
        candidates: total,
        extracted,
        hardcoded,
        coverage: total ? round(extracted / total) : 1,
        deadKeys: catalogKeys ? catalogKeys.size - used.size : 0,
        totalKeys: catalogKeys?.size ?? 0,
        byFile,
        byDir,
    };
}
function round(n) {
    return Math.round(n * 1000) / 1000;
}
/** Catalog keys that no longer appear anywhere — the "dead key" half of maintenance. */
function findDeadKeys(scan, catalogKeys) {
    const seen = new Set();
    for (const d of scan.items) {
        const v = (d.candidate.value ?? '').trim();
        if (KEY_SHAPE.test(v))
            seen.add(v);
        if (d.candidate.meta.wrapped)
            seen.add(v);
    }
    const dead = [];
    for (const k of catalogKeys)
        if (!seen.has(k))
            dead.push(k);
    return dead.sort();
}
