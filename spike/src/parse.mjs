import { parse as babelParse } from '@babel/parser';
import { parse as sfcParse } from '@vue/compiler-sfc';
import { baseParse as vueBaseParse, NodeTypes as VT } from '@vue/compiler-core';
import { lineCol } from './fsx.mjs';

export const UI_COPY_KEYS = new Set([
  'title', 'label', 'placeholder', 'description', 'content', 'message', 'text',
  'tooltip', 'okText', 'cancelText', 'confirmText', 'emptyText', 'noDataText',
  'alt', 'aria-label', 'aria-description', 'aria-placeholder', 'ariaLabel',
  'header', 'subheader', 'subtitle', 'caption', 'hint', 'help', 'error', 'success',
  'warning', 'prompt', 'confirm', 'cancel', 'summary', 'heading', 'emptyMessage',
  'helperText', 'loadingText', 'errorMessage', 'successMessage', 'ok', 'close',
]);

export const TRANSLATABLE_ATTRS = new Set([
  'placeholder', 'title', 'alt', 'label', 'description', 'aria-label',
  'aria-description', 'aria-placeholder', 'aria-roledescription', 'heading',
  'caption', 'empty-text', 'no-data-text', 'help', 'hint', 'sub-title', 'subtitle',
  'text', 'summary', 'tooltip', 'content', 'message', 'ok-text', 'cancel-text',
  'confirm-text', 'loading-text', 'empty-message', 'helper-text',
]);

export const MESSAGE_CALLEES = new Set([
  'message.success', 'message.error', 'message.warning', 'message.info', 'message.loading',
  'notification.success', 'notification.error', 'notification.warning', 'notification.info',
  'notification.open', 'toast', 'toast.success', 'toast.error', 'toast.info', 'toast.warning',
  'showToast', 'showMessage', 'showNotification', 'notify.error', 'notify.success',
  'ElMessage', 'ElMessageBox.confirm', 'ElMessageBox.alert', 'ElNotification',
  'alert', 'confirm', 'prompt', 'Modal.confirm', 'Modal.info', 'Modal.error',
  'Modal.success', 'Modal.warning', 'dialog.error', 'dialog.success',
  'console.error', 'console.warn', 'console.log', 'console.info', 'console.debug',
]);

export const I18N_CALLEES = new Set([
  't', '$t', 'i18n.t', 'i18n.global.t', 'formatMessage', 'intl.formatMessage',
  'getTranslations', 'useTranslations', 'translate', 'tr', 'trans', 'i18next.t',
  'this.$t', 'ctx.t', 'useI18n.t', 'i18nT',
]);

const SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments',
  'innerComments', 'comments', 'errors', 'tokens', 'type',
]);

function isNode(v) {
  return v && typeof v === 'object' && typeof v.type === 'string';
}

/** Depth-first walk with ancestor stack. Iterator over every AST node. */
export function walk(root, visit) {
  const ancestors = [];
  const stack = [{ node: root, parent: null, key: null }];
  while (stack.length) {
    const frame = stack.pop();
    const { node, parent, key } = frame;
    if (!isNode(node)) continue;
    ancestors.push(node);
    visit(node, parent, key, ancestors);

    const push = (child, k, childParent) => {
      if (!child || SKIP_KEYS.has(k)) return;
      if (Array.isArray(child)) {
        for (let i = child.length - 1; i >= 0; i--) {
          if (isNode(child[i])) stack.push({ node: child[i], parent: childParent, key: k });
        }
      } else if (isNode(child)) {
        stack.push({ node: child, parent: childParent, key: k });
      }
    };
    for (const k of Object.keys(node)) push(node[k], k, node);
    // NOTE: ancestors are approximate (pop happens before children are visited);
    // parse.mjs relies on `parent`/`key` for local context only.
    ancestors.pop();
  }
}

function inside(ranges, pos) {
  for (const [s, e] of ranges) if (pos >= s && pos < e) return true;
  return false;
}

/** Figma-style SVG assets are exported as inline <svg> blobs; their ids/labels are not copy. */
function svgRangesScript(ast) {
  const ranges = [];
  walk(ast, (node) => {
    if (node.type === 'JSXElement') {
      const n = node.openingElement?.name;
      const tag = n && (n.name || (n.type === 'JSXNamespacedName' ? n.name.name : ''));
      if (tag === 'svg') ranges.push([node.start, node.end]);
    }
  });
  return ranges;
}

function svgRangesVue(tpl) {
  const ranges = [];
  const rec = (node) => {
    if (!node || typeof node.type !== 'number') return;
    if (node.type === VT.ELEMENT) {
      if (node.tag === 'svg') ranges.push([node.loc.start.offset, node.loc.end.offset]);
      for (const k of node.children || []) rec(k);
      return;
    }
    for (const k of node.children || []) rec(k);
  };
  rec(tpl);
  return ranges;
}


/* ---------------- rich text (D2) ---------------- */
const INLINE_TAGS = new Set(['a', 'b', 'span', 'strong', 'em', 'code', 'i', 's', 'small', 'u', 'mark', 'bdi', 'br'])

function tagOf (node) {
  const n = node.openingElement?.name
  return n && n.type === 'JSXIdentifier' ? n.name : ''
}

function isInlineJsx (node) {
  if (!INLINE_TAGS.has(tagOf(node))) return false
  let ok = true
  walk(node, (n) => {
    if (n !== node && n.type === 'JSXElement' && !INLINE_TAGS.has(tagOf(n))) ok = false
    if (n.type === 'JSXExpressionContainer') {
      const et = n.expression?.type
      if (et === 'LogicalExpression' || et === 'ConditionalExpression' || et === 'JSXElement' || et === 'JSXFragment') ok = false
    }
  })
  return ok
}

function elementPart (node, code) {
  const children = []
  for (const k of node.children || []) {
    if (k.type === 'JSXText') children.push({ type: 'text', value: k.value })
    else if (k.type === 'JSXExpressionContainer' && k.expression && k.expression.type !== 'JSXEmptyExpression') children.push({ type: 'expr', code: code.slice(k.expression.start, k.expression.end) })
    else if (k.type === 'JSXElement' && isInlineJsx(k)) children.push(elementPart(k, code))
    else children.push({ type: 'opaque' })
  }
  return { type: 'element', tag: tagOf(node), open: code.slice(node.openingElement.start, node.openingElement.end), children }
}

/** one numbering pass so the catalog string and the emitted code can never disagree */
export function serializeRich (parts) {
  const values = []
  const tags = []
  const emit = (ps) => ps.map((pt) => {
    if (pt.type === 'text') return pt.value
    if (pt.type === 'expr') {
      const name = `v${values.length}`
      values.push({ name, code: pt.code })
      return `{${name}}`
    }
    if (pt.type === 'opaque') return ''
    const idx = tags.length
    tags.push({ open: pt.open })
    return `<${idx}>${emit(pt.children ?? [])}</${idx}>`
  }).join('')
  return { template: normalizeSpace(emit(parts)), values, tags }
}

export function parseJs(code, { typescript = true, jsx = true } = {}) {
  return babelParse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      ...(typescript ? ['typescript', { disallowAmbiguousJSXLike: false }].slice(0, 1) : []),
      ...(jsx ? ['jsx'] : []),
      'decorators-legacy',
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'importAssertions',
      'topLevelAwait',
      'explicitResourceManagement',
    ],
  });
}

function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj = calleeName(node.object);
    const prop = node.property.type === 'Identifier' ? node.property.name : '';
    return obj ? `${obj}.${prop}` : prop;
  }
  return '';
}

export function hasCjk(s) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(s);
}

/** Collapse JSX/Vue whitespace the way the runtime does. */
export function normalizeSpace(s) {
  return s.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function pushItem(items, seen, item) {
  const k = `${item.start}:${item.end}:${item.kind}`;
  if (seen.has(k)) return;
  seen.add(k);
  items.push(item);
}

function litValue(node, code) {
  if (node.type === 'StringLiteral') return { value: node.value, hasExpr: false, parts: [{ type: 'text', value: node.value }] };
  if (node.type === 'TemplateLiteral') {
    const parts = [];
    node.quasis.forEach((q, i) => {
      const v = q.value.cooked ?? q.value.raw;
      if (v) parts.push({ type: 'text', value: v });
      const e = node.expressions[i];
      if (e) parts.push({ type: 'expr', code: code.slice(e.start, e.end) });
    });
    return { value: parts.map((p) => (p.type === 'text' ? p.value : '${' + p.code + '}')).join(''), hasExpr: node.expressions.length > 0, parts };
  }
  return { value: '', hasExpr: false, parts: [] };
}

function makeItem(base, text, start, end, kind, meta) {
  const { line, col } = lineCol(text, start);
  return { ...base, start, end, line, col, kind, meta: meta || {} };
}

/**
 * Collect the candidate universe (pool) from a JS/TS/JSX/TSX AST.
 * The pool is a deliberately permissive superset: detection later decides.
 */
export function collectScriptPool(ast, code, file) {
  const items = [];
  const seen = new Set();
  const base = { file, lang: 'script' };
  const handled = new Set();

  walk(ast, (node, parent, key) => {
    // ---- JSX attribute string values -------------------------------------
    if (node.type === 'JSXAttribute' && node.value) {
      const name = node.name.type === 'JSXIdentifier' ? node.name.name : (node.name.name && node.name.name.name) || '';
      if (node.value.type === 'StringLiteral') {
        const v = node.value.value;
        if (v.trim() && (TRANSLATABLE_ATTRS.has(name) || hasCjk(v))) {
          const it = makeItem(base, code, node.value.start, node.value.end, 'jsx-attr', { attrName: name, attrKind: 'static' });
          it.value = v;
          it.raw = code.slice(node.value.start, node.value.end);
          pushItem(items, seen, it);
          handled.add(node.value.start);
        }
      } else if (node.value.type === 'JSXExpressionContainer') {
        const e = node.value.expression;
        if (e && (e.type === 'StringLiteral' || e.type === 'TemplateLiteral')) {
          const lv = litValue(e, code);
          const it = makeItem(base, code, e.start, e.end, 'jsx-attr', {
            attrName: name, attrKind: 'expr', quote: e.type === 'StringLiteral' ? e.extra?.raw : undefined,
            hasExpr: lv.hasExpr, parts: lv.parts,
          });
          it.value = lv.value;
          it.raw = code.slice(e.start, e.end);
          pushItem(items, seen, it);
          handled.add(e.start);
        }
      }
      return;
    }

    // ---- Calls: message APIs / i18n APIs ---------------------------------
    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      const first = node.arguments && node.arguments[0];
      const isMsg = MESSAGE_CALLEES.has(name);
      const isI18n = I18N_CALLEES.has(name);
      if (first && (first.type === 'StringLiteral' || first.type === 'TemplateLiteral')) {
        if (isMsg || isI18n) {
          const lv = litValue(first, code);
          const it = makeItem(base, code, first.start, first.end,
            first.type === 'StringLiteral' ? 'call-arg' : 'template-literal', {
              callee: name, wrapped: isI18n, hasExpr: lv.hasExpr, parts: lv.parts,
            });
          it.value = lv.value;
          it.raw = code.slice(first.start, first.end);
          pushItem(items, seen, it);
          handled.add(first.start);
        }
      }
      return;
    }

    // ---- Object properties with UI-copy key names ------------------------
    if (node.type === 'ObjectProperty' || node.type === 'Property') {
      const kname = node.key && (node.key.name || node.key.value);
      if (typeof kname === 'string' && UI_COPY_KEYS.has(kname) && node.value) {
        const v = node.value;
        if (v.type === 'StringLiteral' || v.type === 'TemplateLiteral') {
          const lv = litValue(v, code);
          const it = makeItem(base, code, v.start, v.end,
            v.type === 'StringLiteral' ? 'obj-prop' : 'template-literal', {
              propName: kname, hasExpr: lv.hasExpr, parts: lv.parts,
            });
          it.value = lv.value;
          it.raw = code.slice(v.start, v.end);
          pushItem(items, seen, it);
          handled.add(v.start);
        }
      }
      return;
    }

    // ---- Fallback: every other string-ish literal that looks like prose ---
    if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') {
      if (handled.has(node.start)) return;
      // tagged templates (css`…`, gql`…`, html`…`) are DSL payloads, never UI copy
      if (parent && parent.type === 'TaggedTemplateExpression') return;
      // skip import specifiers / require() / keys / member props
      if (parent) {
        if (parent.type === 'ImportDeclaration') return;
        if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportAllDeclaration') return;
        if (parent.type === 'ImportAttribute') return;
        if (parent.type === 'ObjectProperty' || parent.type === 'Property') return;
        if (parent.type === 'MemberExpression' && key === 'property') return;
        if (parent.type === 'JSXAttribute' && key === 'value') return;
        if (parent.type === 'CallExpression' && key === 'callee') return;
        if (parent.type === 'TSLiteralType' || parent.type === 'TSUnionType') return;
        if (parent.type === 'StringLiteral') return;
      }
      const value = node.type === 'StringLiteral' ? node.value : node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${}');
      const hasExpr = node.type === 'TemplateLiteral' && node.expressions.length > 0;
      if (!value || !value.trim()) return;
      if (!hasExpr && !hasCjk(value) && !(/\s/.test(value.trim()) && /[a-zA-Z]/.test(value) && value.trim().length >= 4)) return;
      const callee = parent && parent.type === 'CallExpression' ? calleeName(parent.callee) : '';
      const it = makeItem(base, code, node.start, node.end,
        node.type === 'StringLiteral' ? 'string-literal' : 'template-literal', {
          hasExpr, callee, wrapped: I18N_CALLEES.has(callee),
        });
      it.value = value;
      it.raw = code.slice(node.start, node.end);
      pushItem(items, seen, it);
    }
  });

  // ---- JSX children sentences (text + interpolation + inline elements) --
  walk(ast, (node) => {
    if (node.type !== 'JSXElement' && node.type !== 'JSXFragment') return
    const kids = node.children || []
    let i = 0
    while (i < kids.length) {
      const c = kids[i]
      if (c.type !== 'JSXText') { i++; continue }
      const parts = []
      let j = i
      let lastEnd = c.start
      let hasElement = false
      while (j < kids.length) {
        const k = kids[j]
        if (k.type === 'JSXText') {
          parts.push({ type: 'text', value: k.value })
          lastEnd = k.end
          j++
        } else if (k.type === 'JSXExpressionContainer' && k.expression && k.expression.type !== 'JSXEmptyExpression') {
          // D2: never cross a conditional or an embedded element — that is not one sentence
          const et = k.expression.type
          if (et === 'LogicalExpression' || et === 'ConditionalExpression' || et === 'JSXElement' || et === 'JSXFragment') break
          parts.push({ type: 'expr', code: code.slice(k.expression.start, k.expression.end) })
          lastEnd = k.end
          j++
        } else if (k.type === 'JSXElement' && isInlineJsx(k)) {
          parts.push(elementPart(k, code))
          hasElement = true
          lastEnd = k.end
          j++
        } else break
      }
      const plainText = parts.map((pt) => (pt.type === 'text' ? pt.value : ' ')).join('')
      if (hasElement) {
        const meta = { parts, exprCount: parts.filter((pt) => pt.type === 'expr').length }
        const rich = serializeRich(parts)
        if (normalizeSpace(rich.template)) {
          meta.rich = rich
          const item = makeItem(base, code, c.start, lastEnd, 'jsx-rich', meta)
          item.value = rich.template
          item.raw = code.slice(c.start, lastEnd)
          pushItem(items, seen, item)
        }
      } else if (normalizeSpace(plainText)) {
        const meta = {
          parts: parts.filter((pt) => !(pt.type === 'text' && !pt.value.trim())),
          exprCount: parts.filter((pt) => pt.type === 'expr').length,
        }
        const item = makeItem(base, code, c.start, lastEnd, meta.exprCount ? 'jsx-sentence' : 'jsx-text', meta)
        item.value = normalizeSpace(plainText)
        item.raw = code.slice(c.start, lastEnd)
        pushItem(items, seen, item)
      }
      i = j
    }
  })

  // a rich unit swallows every smaller item nested inside it (plain or rich)
  const richRanges = items.filter((it) => it.kind === 'jsx-rich').map((it) => [it.start, it.end])
  const strictlyInside = (it) => richRanges.some(([s, e]) => s <= it.start && e >= it.end && (s < it.start || e > it.end))
  const kept = richRanges.length ? items.filter((it) => !strictlyInside(it)) : items

  const svg = svgRangesScript(ast);
  return svg.length ? kept.filter((it) => !inside(svg, it.start)) : kept;
}
export function collectVuePool(source, file) {
  const items = [];
  const seen = new Set();
  const base = { file, lang: 'vue' };
  const { descriptor, errors } = sfcParse(source, { filename: file });
  const template = descriptor.template;
  if (template && template.ast) {
    const tpl = template.ast;
    const visitVue = (node, parent) => {
      if (!node || typeof node.type !== 'number') return;
      if (node.type === VT.ATTRIBUTE && node.value) {
        const v = node.value;
        if (v.type === VT.TEXT && v.content && v.content.trim()) {
          const at = node.name || '';
          if (TRANSLATABLE_ATTRS.has(at) || hasCjk(v.content)) {
            const it = makeItem(base, source, v.loc.start.offset, v.loc.end.offset, 'vue-attr', { attrName: node.name, attrKind: 'static' });
            it.value = v.content;
            it.raw = source.slice(v.loc.start.offset, v.loc.end.offset);
            pushItem(items, seen, it);
          }
        }
      }
      if (node.type === VT.DIRECTIVE && node.exp && node.exp.type === VT.SIMPLE_EXPRESSION) {
        const e = node.exp;
        const raw = e.content || '';
        if (/^(['"]).*\1$/.test(raw.trim()) && raw.trim().length > 2) {
          const it = makeItem(base, source, e.loc.start.offset, e.loc.end.offset, 'vue-attr', { attrName: node.arg?.content, attrKind: 'bound' });
          it.value = raw.trim().slice(1, -1);
          it.raw = raw;
          pushItem(items, seen, it);
        }
      }
      if (node.type === VT.ELEMENT && node.children) {
        const kids = node.children;
        let i = 0;
        while (i < kids.length) {
          const c = kids[i];
          if (c.type !== VT.TEXT) { i++; continue; }
          const parts = [];
          let j = i;
          let lastEnd = c.loc.end.offset;
          const start = c.loc.start.offset;
          while (j < kids.length) {
            const k = kids[j];
            if (k.type === VT.TEXT) {
              parts.push({ type: 'text', value: k.content });
              lastEnd = k.loc.end.offset;
              j++;
            } else if (k.type === VT.INTERPOLATION && k.content?.content) {
              parts.push({ type: 'expr', code: k.content.content });
              lastEnd = k.loc.end.offset;
              j++;
            } else break;
          }
          const combined = parts.map((p) => (p.type === 'text' ? p.value : ' ')).join('');
          if (normalizeSpace(combined)) {
            const meta = { parts: parts.filter((p) => !(p.type === 'text' && !p.value.trim())), exprCount: parts.filter((p) => p.type === 'expr').length };
            const item = makeItem(base, source, start, lastEnd, meta.exprCount ? 'vue-sentence' : 'vue-text', meta);
            item.value = normalizeSpace(combined);
            item.raw = source.slice(start, lastEnd);
            pushItem(items, seen, item);
          }
          i = j;
        }
      }
      const kids = node.children || [];
      for (const k of kids) visitVue(k, node);
      if (node.type === VT.ELEMENT && node.props) for (const p of node.props) visitVue(p, node);
      if (node.type === VT.INTERPOLATION) visitVue(node.content, node);
    };
    visitVue(tpl, null);
  }

  // <script> / <script setup> blocks
  if (descriptor.script || descriptor.scriptSetup) {
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      let ast;
      try {
        ast = parseJs(block.content, { typescript: block.lang === 'ts', jsx: false });
      } catch {
        continue;
      }
      const sub = collectScriptPool(ast, block.content, file);
      // rebase offsets onto SFC source
      const delta = block.loc.start.offset;
      for (const it of sub) {
        const start = it.start + delta;
        const end = it.end + delta;
        if (seen.has(`${start}:${end}:${it.kind}`)) continue;
        const { line, col } = lineCol(source, start);
        items.push({ ...it, start, end, line, col, lang: 'vue' });
      }
    }
  }
  if (template && template.ast) {
    const svg = svgRangesVue(template.ast);
    if (svg.length) {
      for (let i = items.length - 1; i >= 0; i--) if (inside(svg, items[i].start)) items.splice(i, 1);
    }
  }
  return { items, sfcErrors: (errors || []).length };
}

/** Unified entry point. */
export function collect(file, source) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (ext === '.vue') {
    const { items, sfcErrors } = collectVuePool(source, file);
    return { items, parseOk: sfcErrors === 0, parseError: sfcErrors ? 'sfc' : null };
  }
  const typescript = ext !== '.jsx' && ext !== '.js' && ext !== '.mjs' && ext !== '.cjs';
  const jsx = ext === '.tsx' || ext === '.jsx' || ext === '.js' || ext === '.mjs' || ext === '.cjs';
  const ast = parseJs(source, { typescript, jsx });
  return { items: collectScriptPool(ast, source, file), parseOk: true, parseError: null };
}

