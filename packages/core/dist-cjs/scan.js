"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fs = exports.path = void 0;
exports.scanSource = scanSource;
exports.scanProject = scanProject;
exports.scanProjectWithProgress = scanProjectWithProgress;
exports.readFileSource = readFileSource;
const node_fs_1 = __importDefault(require("node:fs"));
exports.fs = node_fs_1.default;
const node_path_1 = __importDefault(require("node:path"));
exports.path = node_path_1.default;
const fsx_js_1 = require("./fsx.js");
const parse_js_1 = require("./parse.js");
const detect_js_1 = require("./detect.js");
const fsx_js_2 = require("./fsx.js");
/** Analyze one file: parse → pool → classify. Pure; no filesystem writes. */
function scanSource(file, source, threshold = detect_js_1.THRESHOLD) {
    const { items, parseOk, parseError } = (0, parse_js_1.collect)(file, source);
    const decisions = items.map((candidate) => {
        const c = (0, detect_js_1.classify)(candidate);
        return { candidate, translatable: c.score >= threshold, score: c.score, reasons: c.reasons };
    });
    return { items, decisions, parseOk, parseError };
}
/** Scan a directory tree. Single-threaded on purpose — see docs/05 (D3). */
function scanProject(opts) {
    const started = Date.now();
    const threshold = opts.threshold ?? detect_js_1.THRESHOLD;
    const walkStart = Date.now();
    const files = (0, fsx_js_1.collectFiles)(opts.root, {
        include: (rel) => {
            if (fsx_js_1.TEST_FILE_RE.test(rel))
                return false;
            return opts.include ? opts.include(rel) : true;
        },
        maxFiles: opts.maxFiles,
    });
    const walkMs = Date.now() - walkStart;
    let parseMs = 0;
    let detectMs = 0;
    const perFile = [];
    const items = [];
    const parseErrors = [];
    for (const f of files) {
        const fileStart = Date.now();
        let source;
        try {
            source = (0, fsx_js_1.readSource)(f.abs);
        }
        catch (e) {
            parseErrors.push({ file: f.rel, error: e.message });
            continue;
        }
        const p0 = Date.now();
        let items0 = [];
        let parseOk = true;
        let parseError = null;
        try {
            const r = (0, parse_js_1.collect)(f.rel, source);
            items0 = r.items;
            parseOk = r.parseOk;
            parseError = r.parseError;
        }
        catch (e) {
            parseOk = false;
            parseError = e.message;
        }
        parseMs += Date.now() - p0;
        if (!parseOk && parseError)
            parseErrors.push({ file: f.rel, error: parseError });
        const d0 = Date.now();
        let accepted = 0;
        for (const candidate of items0) {
            const c = (0, detect_js_1.classify)(candidate);
            const decision = { candidate, translatable: c.score >= threshold, score: c.score, reasons: c.reasons };
            if (decision.translatable)
                accepted++;
            items.push(decision);
        }
        detectMs += Date.now() - d0;
        perFile.push({ file: f.rel, bytes: f.size, ms: Date.now() - fileStart, pool: items0.length, accepted });
    }
    const totalMs = Date.now() - started;
    const acceptedCount = items.filter((d) => d.translatable).length;
    return {
        root: opts.root,
        files: files.length,
        pool: items.length,
        accepted: acceptedCount,
        parseErrors,
        timings: {
            walkMs,
            parseMs,
            detectMs,
            totalMs,
            perFileMs: (0, fsx_js_1.summarizeTimings)(perFile),
            filesPerSec: totalMs > 0 ? Math.round((files.length / totalMs) * 1000) : 0,
        },
        items,
        perFile,
    };
}
/** Convenience for CLI/extension: scan and report progress per file. */
function scanProjectWithProgress(root, opts = {}) {
    const threshold = opts.threshold ?? detect_js_1.THRESHOLD;
    const files = (0, fsx_js_1.collectFiles)(root, { maxFiles: opts.maxFiles, include: (rel) => !fsx_js_1.TEST_FILE_RE.test(rel) });
    const started = Date.now();
    const perFile = [];
    const items = [];
    const parseErrors = [];
    let cancelled = false;
    let parseMs = 0;
    let detectMs = 0;
    let i = 0;
    for (const f of files) {
        if (opts.shouldCancel?.()) {
            cancelled = true;
            break;
        }
        const fileStart = Date.now();
        let source;
        try {
            source = (0, fsx_js_1.readSource)(f.abs);
        }
        catch (e) {
            parseErrors.push({ file: f.rel, error: e.message });
            continue;
        }
        const p0 = Date.now();
        let pool = [];
        try {
            const r = (0, parse_js_1.collect)(f.rel, source);
            pool = r.items;
            if (!r.parseOk && r.parseError)
                parseErrors.push({ file: f.rel, error: r.parseError });
        }
        catch (e) {
            parseErrors.push({ file: f.rel, error: e.message });
        }
        parseMs += Date.now() - p0;
        const d0 = Date.now();
        let accepted = 0;
        for (const candidate of pool) {
            const c = (0, detect_js_1.classify)(candidate);
            const decision = { candidate, translatable: c.score >= threshold, score: c.score, reasons: c.reasons };
            if (decision.translatable)
                accepted++;
            items.push(decision);
        }
        detectMs += Date.now() - d0;
        perFile.push({ file: f.rel, bytes: f.size, ms: Date.now() - fileStart, pool: pool.length, accepted });
        i++;
        opts.onFile?.(i, files.length, f.rel);
    }
    const totalMs = Date.now() - started;
    return {
        root,
        files: i,
        pool: items.length,
        accepted: items.filter((d) => d.translatable).length,
        parseErrors,
        timings: {
            walkMs: 0,
            parseMs,
            detectMs,
            totalMs,
            perFileMs: (0, fsx_js_1.summarizeTimings)(perFile),
            filesPerSec: totalMs > 0 ? Math.round((i / totalMs) * 1000) : 0,
        },
        items,
        perFile,
    };
}
/** Read a source block (used by the extension to rewrite a single open file). */
function readFileSource(abs) {
    const source = (0, fsx_js_1.readSource)(abs);
    return { source, lineMap: (pos) => (0, fsx_js_2.lineCol)(source, pos).line };
}
