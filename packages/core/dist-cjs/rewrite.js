"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.veto = veto;
exports.planFile = planFile;
exports.syntaxCheck = syntaxCheck;
exports.applyFile = applyFile;
exports.rewriteProject = rewriteProject;
exports.exportCatalogs = exportCatalogs;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const compiler_sfc_1 = require("@vue/compiler-sfc");
const parse_js_1 = require("./parse.js");
const fsx_js_1 = require("./fsx.js");
const keys_js_1 = require("./keys.js");
const detect_js_1 = require("./detect.js");
/* eslint-disable @typescript-eslint/no-explicit-any -- AST nodes */
const DEFAULT_THRESHOLD = 0.5;
/* ---------------- template placeholders ---------------- */
const TPL_PREFIX = 'const __t = ';
/**
 * Recover quasis/expressions straight from the source. The analyzer's metadata is
 * not always enough (fallback template literals only carry `${}`) and trusting a
 * lossy value silently deletes interpolations from the emitted code.
 */
function partsFromSource(source, item) {
    const slice = source.slice(item.start, item.end);
    if (!slice.startsWith('`'))
        return null;
    let tl = null;
    try {
        (0, parse_js_1.walk)((0, parse_js_1.parseJs)(TPL_PREFIX + slice, {}), (n) => {
            if (n.type === 'TemplateLiteral' && !tl)
                tl = n;
        });
    }
    catch {
        return null;
    }
    if (!tl)
        return null;
    const off = TPL_PREFIX.length;
    const parts = [];
    tl.quasis.forEach((q, i) => {
        if (q.value.cooked)
            parts.push({ type: 'text', value: q.value.cooked });
        const e = tl.expressions[i];
        if (e)
            parts.push({ type: 'expr', code: slice.slice(e.start - off, e.end - off) });
    });
    return parts;
}
/**
 * Normalize items so key generation, catalog values and the emitted call all read
 * the same derived template. Mutates in place (items are per-run copies).
 */
function normalizeItems(source, items) {
    for (const it of items) {
        if (it.kind !== 'template-literal')
            continue;
        const parts = partsFromSource(source, it);
        if (!parts)
            continue;
        it.meta = { ...it.meta, parts };
        let tpl = '';
        let n = 0;
        for (const p of parts) {
            if (p.type === 'text')
                tpl += p.value;
            else if (/^(['"`])\s*\1$/.test(p.code))
                tpl += p.code.slice(1, -1); // {' '} is just a space
            else
                tpl += `{v${n++}}`;
        }
        it.value = tpl;
        it.raw = tpl;
    }
}
function buildTemplate(item) {
    const parts = item.meta.parts ?? [];
    if (!parts.length)
        return { template: item.value, args: [] };
    const args = [];
    let template = '';
    for (const p of parts) {
        if (p.type === 'text')
            template += p.value;
        else if (/^(['"`])\s*\1$/.test(p.code))
            template += p.code.slice(1, -1);
        else {
            const name = `v${args.length}`;
            args.push({ name, code: p.code });
            template += `{${name}}`;
        }
    }
    return { template, args };
}
function transTag(item, file, registry) {
    const rich = item.meta.rich;
    const values = rich?.values ?? [];
    const tags = rich?.tags ?? [];
    const key = registry.keyFor(file, item, item.value);
    const v = values.length ? ` values={{ ${values.map((x) => `${x.name}: ${x.code}`).join(', ')} }}` : '';
    const comps = tags.map((t) => t.open.replace(/\s*>$/, ' />'));
    const cb = comps.length ? ` components={[${comps.join(', ')}]}` : '';
    return `<Trans i18nKey="${key}"${v}${cb} />`;
}
function callFor(item, alias, q, file, registry) {
    const { template, args } = buildTemplate(item);
    const key = registry.keyFor(file, item, template);
    return args.length
        ? `${alias}(${q}${key}${q}, { ${args.map((a) => `${a.name}: ${a.code}`).join(', ')} })`
        : `${alias}(${q}${key}${q})`;
}
function functionRanges(ast, source) {
    const fns = [];
    (0, parse_js_1.walk)(ast, (node) => {
        const isFn = node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression' ||
            node.type === 'ClassMethod' ||
            node.type === 'ObjectMethod' ||
            node.type === 'TSDeclareMethod';
        if (!isFn || !node.body)
            return;
        const block = node.body.type === 'BlockStatement';
        const jsxBody = node.body.type === 'JSXElement' || node.body.type === 'JSXFragment';
        if (!block && !jsxBody)
            return;
        const text = source.slice(node.body.start, node.body.end);
        // Only functions that actually render JSX may use hooks.
        const componentish = block ? /<\/[A-Za-z]|\/>/.test(text) : true;
        fns.push({ start: node.start, end: node.end, bodyStart: node.body.start, componentish, hookable: block });
    });
    return fns.sort((a, b) => a.start - b.start);
}
/* ---------------- guards ---------------- */
/**
 * A literal glued to a preceding identifier/template char means we are inside a
 * tagged template (`css`…``) or another DSL. Rewriting it yields code that still
 * parses but is semantically wrong — the exact failure the AST gate misses.
 */
function tagGuard(source, item) {
    if (item.kind !== 'template-literal' && item.kind !== 'string-literal')
        return null;
    const prev = source[item.start - 1] ?? '';
    if (/[A-Za-z0-9_$`]/.test(prev))
        return 'tagged-template';
    return null;
}
/**
 * Cheap self-check: the slice we are about to replace must still look like the
 * literal the analyzer saw. Catches stale offsets (BOM, encoding, CRLF drift).
 */
function literalShapeGuard(source, item) {
    const q = source[item.start];
    const close = source[item.end - 1];
    if (q !== "'" && q !== '"' && q !== '`')
        return 'offset-drift:open';
    if (close !== q)
        return 'offset-drift:close';
    return null;
}
/* ---------------- vetoes: strings that must never become UI copy ---------------- */
const KEYLIKE = /^[a-z0-9_]+([.-][a-z0-9_]+)+$/i;
const LITERAL_KINDS = new Set(['call-arg', 'string-literal', 'obj-prop', 'template-literal']);
const STYLE_PROPS = new Set(['class', 'classname', 'style', 'classlist']);
function textOf(item) {
    const parts = item.meta.parts;
    if (parts?.length)
        return parts.filter((p) => p.type === 'text').map((p) => p.value).join('');
    return item.value ?? '';
}
function veto(source, item) {
    const v = item.value ?? '';
    if (/\bconsole\./.test(item.meta.callee ?? ''))
        return 'console-log';
    if (KEYLIKE.test(v.trim()) && !/\s/.test(v.trim()))
        return 'key-like';
    if (/^(Bearer|Basic|Digest|Token)\s/i.test(v.trim()))
        return 'technical-string';
    const prop = String(item.meta.attrName ?? item.meta.propName ?? '').toLowerCase();
    if (STYLE_PROPS.has(prop))
        return 'style-prop';
    // `const mergedClass = `…`` / `className: …` — presentation strings, not copy
    const before = source.slice(Math.max(0, item.start - 80), item.start);
    const idm = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before);
    if (idm && /class|style|slot|cls/i.test(idm[1]))
        return 'style-context';
    // code / CSS / SQL / selector smuggled into a template literal
    const text = textOf(item);
    if (/[[\]]|=>|[{};]/.test(text) || /\b(px|rem|rgba?|url|http|select|insert|update)\b/i.test(text))
        return 'code-like';
    if (/\]\s*\.|^\s*\.[a-z-]+\s*\{|^[A-Z_]{3,}$/.test(text))
        return 'code-like';
    if (/[a-z-]+\s*=\s*["']/i.test(text))
        return 'code-like';
    return null;
}
function planFile(file, items, source, registry) {
    const isVue = file.endsWith('.vue');
    const isTsx = file.endsWith('.tsx') || file.endsWith('.jsx');
    const plan = { edits: [], skipped: [], notes: [] };
    // build scripts, tooling and config files are not user-facing surface
    if (/(^|\/)(scripts?|tools?|build)\//.test(file) || /\.cjs$/.test(file) || /\.config\.[cm]?[jt]s$/.test(file)) {
        for (const item of items)
            plan.skipped.push({ value: item.value, reason: 'script-file' });
        return plan;
    }
    normalizeItems(source, items);
    if (isVue) {
        const sfc = (0, compiler_sfc_1.parse)(source, { filename: file });
        const scriptBlock = sfc.descriptor.scriptSetup ?? sfc.descriptor.script;
        const hasSetup = !!sfc.descriptor.scriptSetup;
        const scriptOffset = scriptBlock ? scriptBlock.loc.start.offset : 0;
        let needsUseI18n = false;
        for (const item of items) {
            // Callers may hand us the raw pool (the extension does). Anything the scorer would
            // not call copy — an already-wrapped key, a Tailwind class list — must not be
            // rewritten, or a second pass finds work inside the first pass's output.
            if (!(0, detect_js_1.classify)(item).translatable) {
                plan.skipped.push({ value: item.value, reason: 'not-copy' });
                continue;
            }
            const v = veto(source, item);
            if (v) {
                plan.skipped.push({ value: item.value, reason: v });
                continue;
            }
            if (item.kind.startsWith('vue-')) {
                // template: $t is globally available in vue-i18n templates
                if (item.kind === 'vue-attr') {
                    const attr = item.meta.attrName;
                    if (!attr) {
                        plan.skipped.push({ value: item.value, reason: 'vue-attr-name-missing' });
                        continue;
                    }
                    // Two shapes share the kind:
                    //   static  start is the opening quote:  title="值"   (end is past the closing quote)
                    //   bound   start is the expression:     :title="'值'" (end sits before the closing quote)
                    let k = item.start - 1;
                    if (source[k] === '"' || source[k] === "'")
                        k--;
                    while (k >= 0 && /\s/.test(source[k]))
                        k--;
                    if (source[k] !== '=') {
                        plan.skipped.push({ value: item.value, reason: 'vue-attr-shape' });
                        continue;
                    }
                    k--;
                    while (k >= 0 && /\s/.test(source[k]))
                        k--;
                    const nameEnd = k + 1;
                    const nameStart = nameEnd - attr.length;
                    if (source.slice(nameStart, nameEnd) !== attr) {
                        plan.skipped.push({ value: item.value, reason: 'vue-attr-offset-mismatch' });
                        continue;
                    }
                    let end = item.end;
                    if (source[end] === '"' || source[end] === "'")
                        end += 1;
                    plan.edits.push({ start: nameStart, end, text: `:${attr}="${callFor(item, '$t', "'", file, registry)}"` });
                }
                else if (item.kind === 'vue-text' || item.kind === 'vue-sentence') {
                    plan.edits.push({ start: item.start, end: item.end, text: `{{ ${callFor(item, '$t', '"', file, registry)} }}` });
                }
                else {
                    plan.skipped.push({ value: item.value, reason: 'unsupported-vue-kind' });
                }
            }
            else {
                if (!scriptBlock) {
                    plan.skipped.push({ value: item.value, reason: 'no-script-block' });
                    continue;
                }
                if (!hasSetup) {
                    plan.skipped.push({ value: item.value, reason: 'options-api-no-scope' });
                    continue;
                }
                needsUseI18n = true;
                // collectVuePool already rebased script-block offsets onto the SFC source
                plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 't', '"', file, registry) });
            }
        }
        if (needsUseI18n && scriptBlock) {
            const body = source.slice(scriptOffset, scriptOffset + scriptBlock.content.length);
            const importRe = /^import\s[^\n]*?from\s*['"][^'"]+['"];?\s*$/gm;
            let last = -1;
            let m;
            while ((m = importRe.exec(body)))
                last = m.index + m[0].length;
            const injectAt = scriptOffset + (last >= 0 ? last : 0);
            // Re-running over code we already migrated must not add a second copy of the
            // import (a duplicate binding is a hard error) or a second `const { t }`
            // (which would shadow the first and fail to compile).
            const hasImport = /import\s*(?:type\s*)?\{[^}]*\buseI18n\b[^}]*\}\s*from\s*['"]vue-i18n['"]/.test(body);
            const hasTBinding = /(?:const|let|var)\s*\{[^}]*\bt\b[^}]*\}\s*=\s*useI18n\(\)|(?:const|let|var)\s+t\s*=\s*useI18n\(\)\.t/.test(body);
            const parts = [];
            if (!hasImport)
                parts.push(`import { useI18n } from 'vue-i18n'`);
            if (!hasTBinding)
                parts.push(`const { t } = useI18n()`);
            if (parts.length) {
                plan.edits.push({ start: injectAt, end: injectAt, text: `\n${parts.join('\n')}`, kind: 'inject' });
                plan.notes.push(`vue: script-setup ${parts.length === 2 ? 'useI18n + t' : hasImport ? 't' : 'useI18n'} injected`);
            }
        }
        else if (plan.skipped.some((s) => s.reason === 'options-api-no-scope')) {
            plan.notes.push('vue: options-api script items skipped (no composition scope)');
        }
        return plan;
    }
    // JS / TS
    const ast = (0, parse_js_1.parseJs)(source, { typescript: /\.tsx?$/.test(file), jsx: isTsx });
    const fns = isTsx ? functionRanges(ast, source) : [];
    const components = fns.filter((f) => f.componentish);
    const hookFns = new Map();
    let needsTrans = false;
    /** innermost component function containing this offset, if any */
    const componentAt = (pos) => components.filter((f) => f.start <= pos && f.end >= pos).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    for (const item of items) {
        // A drifted offset means we cannot trust anything about this item, so it is checked
        // before scoring: the fingerprint gate must report its own reason, not "not-copy".
        // Only literal kinds are quoted — JSX text and Vue text have no delimiters to check.
        const drift = LITERAL_KINDS.has(item.kind) ? literalShapeGuard(source, item) : null;
        if (drift) {
            plan.skipped.push({ value: item.value, reason: drift });
            continue;
        }
        if (!(0, detect_js_1.classify)(item).translatable) {
            plan.skipped.push({ value: item.value, reason: 'not-copy' });
            continue;
        }
        const v = veto(source, item);
        if (v) {
            plan.skipped.push({ value: item.value, reason: v });
            continue;
        }
        const guarded = tagGuard(source, item);
        if (guarded) {
            plan.skipped.push({ value: item.value, reason: guarded });
            continue;
        }
        const isJsxKind = item.kind === 'jsx-text' || item.kind === 'jsx-sentence' || item.kind === 'jsx-attr' || item.kind === 'jsx-rich';
        if (!isJsxKind) {
            const shape = literalShapeGuard(source, item);
            if (shape) {
                plan.skipped.push({ value: item.value, reason: shape });
                continue;
            }
        }
        if (!isTsx) {
            plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 'i18n.t', '"', file, registry) });
            continue;
        }
        const comp = componentAt(item.start);
        if (item.kind === 'jsx-rich') {
            if (!comp) {
                plan.skipped.push({ value: item.value, reason: 'jsx-no-component-scope' });
                continue;
            }
            needsTrans = true;
            // keep the surrounding whitespace so the rewritten JSX still looks hand-written
            const raw = source.slice(item.start, item.end);
            const lead = /^\s*/.exec(raw)[0];
            const trail = /\s*$/.exec(raw)[0];
            plan.edits.push({ start: item.start, end: item.end, text: `${lead}${transTag(item, file, registry)}${trail}` });
        }
        else if (isJsxKind) {
            if (!comp) {
                plan.skipped.push({ value: item.value, reason: 'jsx-no-component-scope' });
                continue;
            }
            if (comp.hookable)
                hookFns.set(comp.bodyStart, true);
            const alias = comp.hookable ? 't' : 'i18n.t';
            plan.edits.push({ start: item.start, end: item.end, text: `{${callFor(item, alias, '"', file, registry)}}` });
        }
        else if (comp) {
            // nested callbacks inside a component reuse the hook value from the closure
            if (comp.hookable)
                hookFns.set(comp.bodyStart, true);
            const alias = comp.hookable ? 't' : 'i18n.t';
            plan.edits.push({ start: item.start, end: item.end, text: callFor(item, alias, '"', file, registry) });
        }
        else {
            // module scope (mock data, config objects): the imperative singleton is legal here
            plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 'i18n.t', '"', file, registry) });
        }
    }
    if (needsTrans)
        plan.notes.push('react: Trans used');
    if (hookFns.size) {
        for (const bodyStart of hookFns.keys()) {
            // Already declared by an earlier run (or hand-written): the hook call must not be
            // duplicated, and the shadowed copy would be dead code at best.
            const head = source.slice(bodyStart, bodyStart + 160);
            if (/\bconst\s+t\s*=\s*useT\(\)/.test(head))
                continue;
            plan.edits.push({ start: bodyStart + 1, end: bodyStart + 1, text: '\n  const t = useT()', kind: 'inject' });
        }
        plan.notes.push(`react: useT() injected ${hookFns.size} component scope(s)`);
    }
    return plan;
}
/* ---------------- import splicing ---------------- */
function spliceImports(source, file, plan, aliases) {
    const notes = plan.notes.join(' ');
    const wantsUseT = /\buseT\(\)/.test(notes);
    const wantsI18n = plan.edits.some((e) => /\bi18n\.t\(/.test(e.text));
    const wantsTrans = /Trans used/.test(notes);
    if (!wantsUseT && !wantsI18n && !wantsTrans)
        return source;
    const lines = [];
    const alreadyImports = (binding) => new RegExp(`^\\s*import\\b[^\\n]*\\b${binding}\\b[^\\n]*from\\s*['"]`, 'm').test(source);
    if (wantsTrans && !alreadyImports('Trans'))
        lines.push(`import { Trans } from '${aliases?.trans ?? 'react-i18next'}'`);
    if (wantsUseT && !alreadyImports('useT'))
        lines.push(`import { useT } from '${aliases?.useT ?? '@/i18n/react'}'`);
    if (wantsI18n && !alreadyImports('i18n'))
        lines.push(`import { i18n } from '${aliases?.i18n ?? '@/i18n'}'`);
    if (!lines.length)
        return source;
    if (file.endsWith('.vue'))
        return source; // already injected inside <script setup>
    const importRe = /^import\s[^\n]*?from\s*['"][^'"]+['"];?\s*$/gm;
    let last = -1;
    let m;
    while ((m = importRe.exec(source))) {
        if (m.index > 4000)
            break;
        last = m.index + m[0].length;
    }
    const block = lines.join('\n');
    if (last >= 0)
        return source.slice(0, last) + `\n${block}` + source.slice(last);
    // No import to anchor to. Insert after a "use client" / "use strict" prologue when one
    // exists — Next.js rejects modules where the directive is not the first statement.
    const directive = /^(?:'(?:use (?:client|server|strict))'|"(?:use (?:client|server|strict))");?[ \t]*\r?\n/.exec(source);
    const at = directive ? directive[0].length : 0;
    return source.slice(0, at) + block + '\n' + source.slice(at);
}
/* ---------------- syntax gates ---------------- */
/**
 * Syntax gate. Deliberately babel-only: `typescript` is a build-time dependency, and an
 * extension that imports it at runtime ships ~10 MB it cannot resolve from a vsix.
 * `strict` turns off error recovery so a mangled rewrite throws instead of being
 * "recovered" into something that parses.
 */
function checkScript(source, file) {
    try {
        (0, parse_js_1.parseJs)(source, { typescript: /\.tsx?$/.test(file), jsx: /x$/.test(file), strict: true });
        return null;
    }
    catch (e) {
        return String(e.message || e).slice(0, 160);
    }
}
function syntaxCheck(source, file) {
    if (file.endsWith('.vue')) {
        const { errors } = (0, compiler_sfc_1.parse)(source, { filename: file });
        if (errors.length)
            return `sfc:${errors[0].message}`;
        const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
        let m;
        while ((m = re.exec(source))) {
            if (!m[1])
                continue;
            const err = checkScript(m[1], 'blk.ts');
            if (err)
                return `script:${err}`;
        }
        return null;
    }
    const err = checkScript(source, file);
    if (err)
        return `${/\.tsx?$/.test(file) ? 'ts' : 'js'}:${err}`;
    return null;
}
/** Pure: (file, items, source) → rewritten source or null when a gate fired. */
function applyFile(file, items, source, registry, aliases) {
    const report = {
        file,
        applied: 0,
        skipped: [],
        notes: [],
        records: [],
        hadBom: false,
        crlf: false,
        postParseError: undefined,
    };
    const pre = syntaxCheck(source, file);
    if (pre) {
        report.skipped.push({ value: '', reason: `pre-parse:${pre}` });
        return { change: null, report };
    }
    const plan = planFile(file, items, source, registry);
    // gate: overlapping edit ranges
    const sorted = plan.edits.map((e) => ({ ...e })).sort((a, b) => a.start - b.start || a.end - b.end);
    const kept = [];
    for (const e of sorted) {
        const prev = kept[kept.length - 1];
        if (prev && e.start < prev.end) {
            plan.skipped.push({ value: '', reason: 'overlap' });
            continue;
        }
        kept.push(e);
    }
    let out = source;
    for (let i = kept.length - 1; i >= 0; i--) {
        const e = kept[i];
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    out = spliceImports(out, file, plan, aliases);
    const post = syntaxCheck(out, file);
    if (post) {
        report.skipped.push({ value: '', reason: `post-parse:${post}` });
        report.postParseError = post;
        return { change: null, report };
    }
    report.applied = kept.filter((e) => e.kind !== 'inject').length;
    report.notes = plan.notes;
    report.skipped.push(...plan.skipped);
    // Exact record of what changed, so review/catalog can reuse it without guessing.
    report.records = kept
        .filter((e) => e.kind !== 'inject')
        .map((e) => {
        const it = items.find((i) => i.start === e.start && i.end === e.end);
        const key = (/i18nKey="([^"]+)"/.exec(e.text) ?? /\(\s*"([^"]+)"/.exec(e.text) ?? [])[1] ?? '';
        return { start: e.start, end: e.end, kind: it?.kind ?? '', key, value: it?.value ?? '', text: e.text };
    });
    // Normalise inserted line breaks to the file's own convention. Without this, a CRLF
    // file comes back with mixed endings and every extraction shows up as a whole-file
    // diff in git — the fastest way to lose a reviewer's trust.
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const rewritten = out.includes('\r\n') || eol === '\r\n' ? out.replace(/\r?\n/g, eol) : out;
    return {
        // No surviving edit means the file must not be rewritten at all — returning a
        // "change" with an empty edit list invites callers to touch files needlessly.
        change: kept.length
            ? {
                file,
                original: source,
                rewritten,
                edits: report.records,
                skipped: report.skipped,
                hadBom: report.hadBom,
                crlf: report.crlf,
                notes: report.notes,
            }
            : null,
        report,
    };
}
/**
 * Rewrite a whole project from scan decisions.
 * Files are only written when every gate passed — a partial rewrite is not a
 * state we ever want on disk.
 */
function rewriteProject(decisions, opts) {
    const started = Date.now();
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    const registry = new keys_js_1.KeyRegistry(opts.keysFile ?? 'out/keys.json', opts.namespace);
    const byFile = new Map();
    for (const d of decisions) {
        if (d.score < threshold)
            continue;
        const list = byFile.get(d.candidate.file) ?? [];
        list.push(d.candidate);
        byFile.set(d.candidate.file, list);
    }
    const files = [];
    const skipReasons = {};
    const postParseFailures = [];
    let applied = 0;
    let skipped = 0;
    const used = new Set();
    for (const [file, items] of byFile) {
        if (fsx_js_1.TEST_FILE_RE.test(file)) {
            skipped += items.length;
            skipReasons['test-file'] = (skipReasons['test-file'] ?? 0) + items.length;
            continue;
        }
        const abs = node_path_1.default.join(opts.root, file);
        if (!node_fs_1.default.existsSync(abs))
            continue;
        const buf = node_fs_1.default.readFileSync(abs);
        const hadBom = (0, fsx_js_1.detectBom)(buf);
        const crlf = (0, fsx_js_1.detectCrlf)(buf);
        const source = (0, fsx_js_1.readSource)(abs);
        const { change, report } = applyFile(file, items, source, registry, opts.aliases);
        for (const s of report.skipped) {
            const k = (s.reason || 'unknown').split(':')[0];
            skipReasons[k] = (skipReasons[k] ?? 0) + 1;
        }
        skipped += report.skipped.length;
        if (report.postParseError)
            postParseFailures.push({ file, error: report.postParseError });
        if (!change)
            continue;
        for (const rec of report.records)
            if (rec.key)
                used.add(rec.key);
        applied += report.applied;
        const withMeta = { ...change, hadBom, crlf };
        files.push(withMeta);
        if (opts.writeFiles ?? !opts.dryRun) {
            // restore the file's original encoding conventions
            let text = crlf ? change.rewritten.replace(/\r?\n/g, '\r\n') : change.rewritten;
            if (hadBom)
                text = '\uFEFF' + text;
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(abs), { recursive: true });
            node_fs_1.default.writeFileSync(abs, text);
        }
    }
    const live = registry.prune(used);
    const frozen = (opts.saveKeys ?? !opts.dryRun) ? registry.save() : registry.size;
    return {
        files,
        applied,
        skipped,
        skipReasons,
        postParseFailures,
        keysFrozen: frozen,
        keysLive: live,
        ms: Date.now() - started,
    };
}
/** Write a catalog of used keys (namespace-aware) next to the locale files. */
function exportCatalogs(files, outDir) {
    const byKey = new Map();
    for (const f of files)
        for (const e of f.edits)
            if (e.key && e.value)
                byKey.set(e.key, e.value);
    const written = [];
    for (const [locale] of [['zh-CN']]) {
        const obj = {};
        for (const key of [...byKey.keys()].sort())
            obj[key] = byKey.get(key);
        const file = node_path_1.default.join(outDir, `${locale}.json`);
        (0, fsx_js_1.ensureDir)(node_path_1.default.dirname(file));
        (0, fsx_js_1.writeJson)(file, obj);
        written.push(file);
    }
    return { keys: byKey.size, files: written };
}
