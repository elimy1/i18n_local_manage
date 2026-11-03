"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.THRESHOLD = void 0;
exports.classify = classify;
const parse_js_1 = require("./parse.js");
exports.THRESHOLD = 0.5;
const TECH_PATTERNS = [
    /^https?:\/\//i, /^www\./i, /^\/[\w\-./]*$/, /^[a-z]+:\/\//i, /@[\w-]+\.[a-z]{2,}$/i,
    /^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^\d+(\.\d+)?(px|rem|em|vh|vw|%|s|ms)$/i,
    /^[\w-]+\.(js|ts|jsx|tsx|json|css|scss|less|svg|png|jpe?g|gif|webp|md)$/i,
    /^(utf-8|ascii|iso-8859-1)$/i, /^[<>{}[\]()]+$/, /^%[sd]$/, /^\{[^{}]*\}$/,
    /^[a-z]+(_[a-z]+)+$/, /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/, /^[a-z]+(?:[A-Z][a-z]+)+$/,
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/, /^application\/[\w+.-]+$/,
    /^(true|false|null|undefined|NaN)$/,
];
const NON_TEXT_ATTRS = new Set([
    'className', 'class', 'style', 'key', 'ref', 'id', 'name', 'type', 'role', 'href',
    'src', 'srcset', 'to', 'target', 'rel', 'lang', 'dir', 'tabIndex', 'tabindex',
    'htmlFor', 'for', 'width', 'height', 'fill', 'stroke', 'viewBox', 'xmlns', 'size',
    'variant', 'color', 'icon', 'testid', 'data-testid', 'dataTestId', 'autoComplete',
    'autocomplete', 'method', 'action', 'colSpan', 'rowSpan', 'maxLength', 'minLength',
    'pattern', 'accept', 'url', 'path', 'value', 'defaultValue', 'body', 'headers',
    'onClick', 'onChange', 'onSubmit', 'onBlur', 'onFocus', 'onKeyDown', 'onKeyUp',
    'v-model', 'v-if', 'v-for', 'v-show', 'v-html', 'v-text',
]);
function asClassLike(s) {
    const t = s.trim();
    if (!/^[\w\-:.[\]/%#(),\s]+$/.test(t))
        return false;
    return (/(^|\s)(flex|grid|text-|bg-|p[xytb]?-|m[xytb]?-|w-|h-|border|rounded|shadow|hover:|md:|lg:)/.test(t) ||
        t.split(/\s+/).every((p) => /^[\w\-:.[\]/%#(),]+$/.test(p)));
}
/**
 * Decide whether a pool item is user-facing copy that should be externalised.
 * Every decision carries the reasons that produced it — the UI shows them, and
 * precision bugs become debuggable instead of mysterious.
 */
function classify(item) {
    const reasons = [];
    const meta = item.meta ?? {};
    const value = item.value ?? item.raw ?? '';
    const trimmed = value.trim();
    const kind = item.kind;
    let score = 0;
    switch (kind) {
        case 'jsx-text':
        case 'jsx-sentence':
        case 'vue-text':
        case 'vue-sentence':
            score = 0.55;
            break;
        case 'jsx-rich':
            score = 0.6;
            reasons.push('+rich-text');
            break;
        case 'jsx-attr':
        case 'vue-attr': {
            const attr = meta.attrName ?? '';
            if (parse_js_1.TRANSLATABLE_ATTRS.has(attr)) {
                score = 0.55;
                reasons.push(`+translatable-attr(${attr})`);
            }
            else {
                score = 0.15;
                reasons.push(`-non-translatable-attr(${attr || '?'})`);
            }
            break;
        }
        case 'call-arg':
        case 'template-literal': {
            const callee = meta.callee ?? '';
            if (parse_js_1.MESSAGE_CALLEES.has(callee)) {
                score = 0.5;
                reasons.push(`+message-api(${callee})`);
            }
            else {
                score = 0.2;
                reasons.push('-generic-call');
            }
            if (meta.hasExpr) {
                score += 0.1;
                reasons.push('+interpolated');
            }
            break;
        }
        case 'obj-prop':
            score = 0.5;
            reasons.push(`+ui-prop(${String(meta.propName)})`);
            if (meta.hasExpr) {
                score += 0.1;
                reasons.push('+interpolated');
            }
            break;
        default:
            score = (0, parse_js_1.hasCjk)(value) ? 0.45 : 0.25;
            reasons.push('+bare-literal');
    }
    if (meta.wrapped) {
        score -= 1;
        reasons.push('-already-i18n');
    }
    if (!trimmed) {
        score -= 1;
        reasons.push('-empty');
    }
    if ((0, parse_js_1.hasCjk)(trimmed)) {
        score += 0.35;
        reasons.push('+cjk');
    }
    const hasSpace = /\s/.test(trimmed);
    const hasLetter = /[a-zA-Z]/.test(trimmed);
    if (hasSpace && hasLetter) {
        score += 0.15;
        reasons.push('+multiword');
    }
    if (trimmed.length >= 8 && hasLetter) {
        score += 0.05;
        reasons.push('+length');
    }
    if (!(0, parse_js_1.hasCjk)(trimmed)) {
        if (/^[\d\s.,:;!?%+\-*/=<>()[\]{}"'`_|&^~]+$/.test(trimmed)) {
            score -= 1;
            reasons.push('-punctuation-or-number');
        }
        if (TECH_PATTERNS.some((r) => r.test(trimmed))) {
            score -= 0.6;
            reasons.push('-tech-pattern');
        }
        if (!hasSpace && /^[A-Za-z][A-Za-z0-9_$]*$/.test(trimmed) && trimmed.length <= 24) {
            score -= 0.45;
            reasons.push('-identifier-like');
        }
        if (!hasSpace && trimmed.length <= 3) {
            score -= 0.3;
            reasons.push('-too-short');
        }
        if (/^[a-z0-9-]+(\s+[a-z0-9-]+)+$/.test(trimmed) && asClassLike(trimmed)) {
            score -= 0.5;
            reasons.push('-class-list');
        }
        if (/^<[a-zA-Z/][^>]*>$/.test(trimmed)) {
            score -= 0.6;
            reasons.push('-html-snippet');
        }
    }
    const attrName = meta.attrName ?? '';
    if (NON_TEXT_ATTRS.has(attrName)) {
        score -= 0.5;
        reasons.push(`-non-text-attr(${attrName})`);
    }
    const callee = meta.callee ?? '';
    if (/^console\./.test(callee)) {
        score -= 0.5;
        reasons.push('-console');
    }
    if (/^(true|false|null|undefined)$/.test(trimmed)) {
        score -= 1;
        reasons.push('-literal-keyword');
    }
    if (/^[\w$.]+\(.*\)$/.test(trimmed) && !(0, parse_js_1.hasCjk)(trimmed)) {
        score -= 0.4;
        reasons.push('-call-expression');
    }
    score = Math.max(0, Math.min(1, score));
    return { translatable: score >= exports.THRESHOLD, score: Number(score.toFixed(3)), reasons };
}
