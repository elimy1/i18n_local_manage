"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEST_FILE_RE = exports.VUE_EXT = exports.SCRIPT_EXT = void 0;
exports.collectFiles = collectFiles;
exports.readSource = readSource;
exports.stripBom = stripBom;
exports.detectBom = detectBom;
exports.detectCrlf = detectCrlf;
exports.lineCol = lineCol;
exports.readJson = readJson;
exports.writeJson = writeJson;
exports.ensureDir = ensureDir;
exports.percentile = percentile;
exports.summarizeTimings = summarizeTimings;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.SCRIPT_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs']);
exports.VUE_EXT = new Set(['.vue']);
/** Files that are never worth scanning: fixtures, generated code, tests. */
exports.TEST_FILE_RE = /(^|\/)(__tests__|__mocks__|e2e|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DEFAULT_EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
    'coverage', '.cache', '.turbo', 'vendor', 'public', 'assets', 'static',
    '__snapshots__', '.vscode', '.idea', 'target', '.pnpm-store',
]);
/**
 * Recursively collect source files in deterministic (alphabetical) order.
 * Ordering matters: benchmark numbers and key generation must be reproducible.
 */
function collectFiles(root, opts = {}) {
    const out = [];
    const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
    const exclude = opts.excludeDirs ? new Set(opts.excludeDirs) : DEFAULT_EXCLUDE_DIRS;
    const stack = [root];
    while (stack.length && out.length < maxFiles) {
        const dir = stack.pop();
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const subdirs = [];
        for (const e of entries) {
            const abs = node_path_1.default.join(dir, e.name);
            if (e.isDirectory()) {
                if (exclude.has(e.name))
                    continue;
                if (e.name.startsWith('.') && e.name !== '.storybook')
                    continue;
                subdirs.push(abs);
                continue;
            }
            if (!e.isFile())
                continue;
            const ext = node_path_1.default.extname(e.name).toLowerCase();
            if (!exports.SCRIPT_EXT.has(ext) && !exports.VUE_EXT.has(ext))
                continue;
            if (e.name.endsWith('.d.ts') || e.name.endsWith('.min.js'))
                continue;
            const rel = node_path_1.default.relative(root, abs).split(node_path_1.default.sep).join('/');
            if (opts.include && !opts.include(rel))
                continue;
            const st = node_fs_1.default.statSync(abs);
            out.push({ abs, rel, ext, size: st.size, mtimeMs: st.mtimeMs });
            if (out.length >= maxFiles)
                break;
        }
        // Push in reverse so traversal stays alphabetical.
        for (let i = subdirs.length - 1; i >= 0; i--)
            stack.push(subdirs[i]);
    }
    out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return out;
}
/** Read a source file, stripping the UTF-8 BOM so offsets match the parser. */
function readSource(abs) {
    return stripBom(node_fs_1.default.readFileSync(abs).toString('utf8'));
}
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
function detectBom(buf) {
    return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}
function detectCrlf(buf) {
    return buf.includes(Buffer.from('\r\n'));
}
function lineCol(text, index) {
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
function readJson(file, fallback) {
    try {
        return JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function writeJson(file, value) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function ensureDir(dir) {
    node_fs_1.default.mkdirSync(dir, { recursive: true });
}
function percentile(values, p) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}
function summarizeTimings(perFile) {
    const ms = perFile.map((f) => f.ms);
    return {
        p50: percentile(ms, 50),
        p95: percentile(ms, 95),
        max: ms.length ? Math.max(...ms) : 0,
    };
}
