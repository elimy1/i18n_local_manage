import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseJs, walk } from './parse.mjs'
import { readSource } from './fsx.mjs'
import { parse as parseSfc } from '@vue/compiler-sfc'
import ts from 'typescript'
import { KeyRegistry } from './keys.mjs'

const T = 0.5

/* ---------------- keys (D1: structural + semantic) ---------------- */
const registry = new KeyRegistry(process.env.KEYS_FILE || 'out/keys.json')

/* ---------------- template placeholders ---------------- */
const TPL_PREFIX = 'const __t = '
/** Recover quasis/expressions straight from source. The analyzer's own metadata is
 *  not always enough (fallback template literals only carry `${}`), and trusting a
 *  lossy value silently deletes interpolations from the output. */
function partsFromSource (source, item) {
  const slice = source.slice(item.start, item.end)
  if (!slice.startsWith('`')) return null
  let tl = null
  try {
    walk(parseJs(TPL_PREFIX + slice, {}), n => { if (n.type === 'TemplateLiteral' && !tl) tl = n })
  } catch { return null }
  if (!tl) return null
  const off = TPL_PREFIX.length
  const parts = []
  tl.quasis.forEach((q, i) => {
    if (q.value.cooked) parts.push({ type: 'text', value: q.value.cooked })
    const e = tl.expressions[i]
    if (e) parts.push({ type: 'expr', code: slice.slice(e.start - off, e.end - off) })
  })
  return parts
}

/** Normalize items so that key generation, catalog values and the emitted call all
 *  read the same derived template. */
function normalizeItems (source, items) {
  for (const it of items) {
    if (it.kind !== 'template-literal') continue
    const parts = partsFromSource(source, it)
    if (!parts) continue
    it.meta = { ...(it.meta ?? {}), parts }
    let tpl = ''
    let n = 0
    for (const p of parts) {
      if (p.type === 'text') tpl += p.value
      else if (/^(['"`])\s*\1$/.test(p.code)) tpl += p.code.slice(1, -1) // {' '} is just a space
      else tpl += `{v${n++}}`
    }
    it.value = tpl
    it.raw = tpl
  }
}

function buildTemplate (item) {
  const parts = item.meta?.parts ?? []
  if (!parts.length) return { template: item.value, args: [] }
  const args = []
  let template = ''
  for (const p of parts) {
    if (p.type === 'text') template += p.value
    else if (/^(['"`])\s*\1$/.test(p.code)) template += p.code.slice(1, -1)
    else {
      const name = `v${args.length}`
      args.push({ name, code: p.code })
      template += `{${name}}`
    }
  }
  return { template, args }
}

function transTag (item, file) {
  const { values = [], tags = [] } = item.meta?.rich ?? {}
  const key = registry.keyFor(file, item, item.value)
  const v = values.length ? ` values={{ ${values.map(x => `${x.name}: ${x.code}`).join(', ')} }}` : ''
  const comps = tags.map(t => t.open.replace(/\s*>$/, ' />'))
  const cb = comps.length ? ` components={[${comps.join(', ')}]}` : ''
  return `<Trans i18nKey="${key}"${v}${cb} />`
}

function callFor (item, alias, q, file) {
  q = q ?? '"'
  const { template, args } = buildTemplate(item)
  const key = registry.keyFor(file, item, template)
  return args.length
    ? `${alias}(${q}${key}${q}, { ${args.map(a => `${a.name}: ${a.code}`).join(', ')} })`
    : `${alias}(${q}${key}${q})`
}

/* ---------------- scope analysis ---------------- */
function functionRanges (ast, source) {
  const fns = []
  walk(ast, (node, parent) => {
    const isFn = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' || node.type === 'ClassMethod' ||
      node.type === 'ObjectMethod' || node.type === 'TSDeclareMethod'
    if (!isFn || !node.body || node.body.type !== 'BlockStatement') return
    const text = source.slice(node.body.start, node.body.end)
    const componentish = /<\/[A-Za-z]|\/>/.test(text)
    fns.push({ start: node.start, end: node.end, bodyStart: node.body.start, componentish })
  })
  return fns.sort((a, b) => a.start - b.start)
}

/* ---------------- guards ---------------- */
/** A literal glued to a preceding identifier/template char means we are inside a
 *  tagged template (`css`…``) or some other DSL. Rewriting it produces code that
 *  still parses but is semantically wrong — the exact failure the AST gate misses. */
function tagGuard (source, item) {
  if (item.kind !== 'template-literal' && item.kind !== 'string-literal') return null
  const prev = source[item.start - 1] ?? ''
  if (/[A-Za-z0-9_$`]/.test(prev)) return 'tagged-template'
  return null
}

/** Cheap self-check: the slice we are about to replace must still look like the
 *  literal the analyzer saw. Catches stale offsets (BOM, encoding, CRLF drift). */
function literalShapeGuard (source, item) {
  const q = source[item.start]
  const close = source[item.end - 1]
  if (q !== "'" && q !== '"' && q !== '`') return 'offset-drift:open'
  if (close !== q) return 'offset-drift:close'
  return null
}

/* ---------------- vetoes: strings that must never become UI copy ---------------- */
const KEYLIKE = /^[a-z0-9_]+([.-][a-z0-9_]+)+$/i
const STYLE_PROPS = new Set(['class', 'classname', 'style', 'classlist'])

function textOf (item) {
  const parts = item.meta?.parts
  if (parts?.length) return parts.filter(p => p.type === 'text').map(p => p.value).join('')
  return item.value ?? ''
}

function veto (source, item) {
  const v = item.value ?? ''
  if (/\bconsole\./.test(item.meta?.callee ?? '')) return 'console-log'
  if (KEYLIKE.test(v.trim()) && !/\s/.test(v.trim())) return 'key-like'
  if (/^(Bearer|Basic|Digest|Token)\s/i.test(v.trim())) return 'technical-string'
  const prop = String(item.meta?.attrName ?? item.meta?.propName ?? '').toLowerCase()
  if (STYLE_PROPS.has(prop)) return 'style-prop'
  // `const mergedClass = `…`` / `className: …` — presentation strings, not copy
  const before = source.slice(Math.max(0, item.start - 80), item.start)
  const idm = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before)
  if (idm && /class|style|slot|cls/i.test(idm[1])) return 'style-context'
  // code / CSS / SQL / selector smuggled into a template literal
  const text = textOf(item)
  if (/[[\]]|=>|[{};]/.test(text) || /\b(px|rem|rgba?|url|http|select|insert|update)\b/i.test(text)) return 'code-like'
  if (/\]\s*\.|^\s*\.[a-z-]+\s*\{|^[A-Z_]{3,}$/.test(text)) return 'code-like'
  if (/[a-z-]+\s*=\s*["']/i.test(text)) return 'code-like' // html attribute smuggled in a string
  return null
}

/* ---------------- per-file plan ---------------- */
function planFile (file, items, source) {
  const isVue = file.endsWith('.vue')
  const isTsx = file.endsWith('.tsx') || file.endsWith('.jsx')
  const plan = { edits: [], skipped: [], notes: [] }

  // build scripts, tooling and config files are not user-facing surface
  if (/(^|\/)(scripts?|tools?|build)\//.test(file) || /\.cjs$/.test(file) || /\.config\.[cm]?[jt]s$/.test(file)) {
    for (const item of items) plan.skipped.push({ key: item.value, reason: 'script-file' })
    return plan
  }

  normalizeItems(source, items)

  if (isVue) {
    const sfc = parseSfc(source, { filename: file })
    const scriptBlock = sfc.descriptor.scriptSetup || sfc.descriptor.script
    const hasSetup = !!sfc.descriptor.scriptSetup
    const scriptStart = scriptBlock ? source.indexOf(scriptBlock.content, scriptBlock.loc.start.offset) : -1
    const scriptOffset = scriptBlock ? scriptBlock.loc.start.offset : 0

    let needsUseI18n = false
    for (const item of items) {
      const v = veto(source, item)
      if (v) { plan.skipped.push({ key: item.value, reason: v }); continue }
      if (item.kind.startsWith('vue-')) {
        // template: $t is globally available in vue-i18n templates
        const alias = '$t'
        if (item.kind === 'vue-attr') {
          const attr = item.meta?.attrName
          if (!attr) { plan.skipped.push({ key: item.value, reason: 'vue-attr-name-missing' }); continue }
          // Two shapes share the kind:
          //   static  start is the opening quote:  title="值"   (end is past the closing quote)
          //   bound   start is the expression:     :title="'值'" (end sits before the closing quote)
          let k = item.start - 1
          if (source[k] === '"' || source[k] === "'") k--
          while (k >= 0 && /\s/.test(source[k])) k--
          if (source[k] !== '=') { plan.skipped.push({ key: item.value, reason: 'vue-attr-shape' }); continue }
          k--
          while (k >= 0 && /\s/.test(source[k])) k--
          const nameEnd = k + 1
          const nameStart = nameEnd - attr.length
          if (source.slice(nameStart, nameEnd) !== attr) {
            plan.skipped.push({ key: item.value, reason: 'vue-attr-offset-mismatch' }); continue
          }
          let end = item.end
          if (source[end] === '"' || source[end] === "'") end += 1
          plan.edits.push({ start: nameStart, end, text: `:${attr}="${callFor(item, '$t', "'", file)}"` })
        } else if (item.kind === 'vue-text' || item.kind === 'vue-sentence') {
          plan.edits.push({ start: item.start, end: item.end, text: `{{ ${callFor(item, alias, '"', file)} }}` })
        } else {
          plan.skipped.push({ key: item.value, reason: 'unsupported-vue-kind' })
        }
      } else {
        // script-block item
        if (!scriptBlock) { plan.skipped.push({ key: item.value, reason: 'no-script-block' }); continue }
        if (!hasSetup) { plan.skipped.push({ key: item.value, reason: 'options-api-no-scope' }); continue }
        needsUseI18n = true
        // collectVuePool already rebased script-block offsets onto the SFC source
        plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 't', '"', file) })
      }
    }
    if (needsUseI18n && scriptBlock) {
      const injectAt = scriptOffset
      // after the last import inside <script setup>, else at the top
      const body = source.slice(scriptOffset, scriptOffset + scriptBlock.content.length)
      const importRe = /^import\s[^\n]*?from\s*['"][^'"]+['"];?\s*$/gm
      let last = -1
      let m
      while ((m = importRe.exec(body))) last = m.index + m[0].length
      const plusImport = `\nimport { useI18n } from 'vue-i18n'\nconst { t } = useI18n()`
      plan.edits.push({ start: injectAt + (last >= 0 ? last : 0), end: injectAt + (last >= 0 ? last : 0), text: plusImport, kind: 'inject' })
      plan.notes.push('vue: script-setup useI18n injected')
    } else if (plan.skipped.some(s => s.reason === 'options-api-no-scope')) {
      plan.notes.push('vue: options-api script items skipped (no composition scope)')
    }
    return plan
  }

  // JS / TS
  const ast = parseJs(source, { typescript: /\.tsx?$/.test(file), jsx: isTsx })
  const fns = isTsx ? functionRanges(ast, source) : []
  const components = fns.filter(f => f.componentish)
  const hookFns = new Map() // bodyStart -> true
  let needsTrans = false

  /** innermost component function containing this offset, if any */
  const componentAt = (pos) => components
    .filter(f => f.start <= pos && f.end >= pos)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]

  for (const item of items) {
    const v = veto(source, item)
    if (v) { plan.skipped.push({ key: item.value, reason: v }); continue }
    const guarded = tagGuard(source, item)
    if (guarded) { plan.skipped.push({ key: item.value, reason: guarded }); continue }
    const isJsxKind = item.kind === 'jsx-text' || item.kind === 'jsx-sentence' || item.kind === 'jsx-attr' || item.kind === 'jsx-rich'
    if (!isJsxKind) {
      const shape = literalShapeGuard(source, item)
      if (shape) { plan.skipped.push({ key: item.value, reason: shape }); continue }
    }
    if (!isTsx) {
      plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 'i18n.t', '"', file) })
      continue
    }
    const comp = componentAt(item.start)
    if (item.kind === 'jsx-rich') {
      if (!comp) { plan.skipped.push({ key: item.value, reason: 'jsx-no-component-scope' }); continue }
      needsTrans = true
      // keep the surrounding whitespace so the rewritten JSX still looks hand-written
      const raw = source.slice(item.start, item.end)
      const lead = /^\s*/.exec(raw)[0]
      const trail = /\s*$/.exec(raw)[0]
      plan.edits.push({ start: item.start, end: item.end, text: `${lead}${transTag(item, file)}${trail}` })
    } else if (isJsxKind) {
      if (!comp) { plan.skipped.push({ key: item.value, reason: 'jsx-no-component-scope' }); continue }
      hookFns.set(comp.bodyStart, true)
      plan.edits.push({ start: item.start, end: item.end, text: `{${callFor(item, 't', '"', file)}}` })
    } else if (comp) {
      // nested callbacks inside a component reuse the hook value from the closure
      hookFns.set(comp.bodyStart, true)
      plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 't', '"', file) })
    } else {
      // module scope (mock data, config objects): the imperative singleton is legal here
      plan.edits.push({ start: item.start, end: item.end, text: callFor(item, 'i18n.t', '"', file) })
    }
  }

  if (needsTrans) plan.notes.push('react: Trans used')
  if (hookFns.size) {
    for (const bodyStart of hookFns.keys()) {
      plan.edits.push({ start: bodyStart + 1, end: bodyStart + 1, text: `\n  const t = useT()`, kind: 'inject' })
    }
    plan.notes.push(`react: useT() injected into ${hookFns.size} component scope(s)`)
  }
  return plan
}

/* ---------------- import splicing ---------------- */
function spliceImports (source, file, plan) {
  const notes = plan.notes.join(' ')
  const wantsUseT = /\buseT\(\)/.test(notes)
  const wantsI18n = plan.edits.some(e => /\bi18n\.t\(/.test(e.text))
  const wantsUseI18n = /useI18n/.test(notes)
  const wantsTrans = /Trans used/.test(notes)

  const lines = []
  if (wantsTrans) lines.push(`import { Trans } from 'react-i18next'`)
  if (wantsUseT) lines.push(`import { useT } from '@/i18n/react'`)
  if (wantsI18n) lines.push(`import { i18n } from '@/i18n'`)
  if (!lines.length) return source

  if (file.endsWith('.vue')) {
    // imports were injected inside <script setup> already
    return source
  }
  const importRe = /^import\s[^\n]*?from\s*['"][^'"]+['"];?\s*$/gm
  let last = -1
  let m
  while ((m = importRe.exec(source))) {
    if (m.index > 4000) break
    last = m.index + m[0].length
  }
  const block = lines.join('\n')
  if (last >= 0) return source.slice(0, last) + `\n${block}` + source.slice(last)
  return `${block}\n${source}`
}

/* ---------------- syntax gates ---------------- */
function checkTs (source, file) {
  const out = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
    }
  })
  const errs = (out.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  return errs.length ? ts.flattenDiagnosticMessageText(errs[0].messageText, ' ') : null
}

function syntaxCheck (source, file) {
  try {
    if (file.endsWith('.vue')) {
      const { errors } = parseSfc(source, { filename: file })
      if (errors.length) return `sfc:${errors[0].message}`
      const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source)
      if (m) {
        const err = checkTs(m[1], 'blk.ts')
        if (err) return `script:${err}`
      }
      return null
    }
    if (/\.tsx?$/.test(file)) {
      const err = checkTs(source, file)
      if (err) return `ts:${err}`
    }
    parseJs(source, { typescript: /\.tsx?$/.test(file), jsx: /x$/.test(file) })
    return null
  } catch (e) {
    return String(e.message || e).slice(0, 160)
  }
}

/* ---------------- apply ---------------- */
function applyFile (file, items, absRoot) {
  const abs = path.join(absRoot, file)
  const buf = fs.readFileSync(abs)
  const hadBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const crlf = buf.includes(Buffer.from('\r\n'))
  // same reader as the analyzer: BOM stripped, so offsets line up exactly
  const source = readSource(abs)
  const report = { file, applied: 0, skipped: [], keys: [], hadBom, crlf }

  const pre = syntaxCheck(source, file)
  if (pre) { report.skipped.push({ reason: `pre-parse:${pre}` }); return { report, changed: null } }

  const plan = planFile(file, items, source)

  // gate: overlapping edit ranges
  const sorted = plan.edits.map(e => ({ ...e })).sort((a, b) => a.start - b.start || a.end - b.end)
  const kept = []
  for (const e of sorted) {
    const prev = kept[kept.length - 1]
    if (prev && e.start < prev.end) {
      plan.skipped.push({ reason: 'overlap' })
      continue
    }
    kept.push(e)
  }

  let out = source
  for (let i = kept.length - 1; i >= 0; i--) {
    const e = kept[i]
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  out = spliceImports(out, file, plan)

  const post = syntaxCheck(out, file)
  if (post) {
    if (process.env.DEBUG_OUT) {
      fs.mkdirSync(process.env.DEBUG_OUT, { recursive: true })
      fs.writeFileSync(path.join(process.env.DEBUG_OUT, file.replace(/[\\/]/g, '__')), out)
    }
    report.skipped.push({ reason: `post-parse:${post}` })
    return { report, changed: null }
  }

  report.applied = kept.filter(e => e.kind !== 'inject').length
  report.notes = plan.notes
  report.skipped.push(...plan.skipped)
  // exact record of what changed, so review/catalog can reuse it without guessing
  report.records = kept
    .filter(e => e.kind !== 'inject')
    .map(e => {
      const it = items.find(i => i.start === e.start && i.end === e.end)
      const key = (/i18nKey="([^"]+)"/.exec(e.text) ?? /\(\s*"([^"]+)"/.exec(e.text) ?? [])[1] ?? ''
      return { start: e.start, kind: it?.kind ?? e.kind ?? '', key, value: it?.value ?? '' }
    })
  report.keys = [...new Set((out.match(/"(auto\.[a-z0-9-]+)"/g) ?? []).map(s => s.slice(1, -1)))]
  return { report, changed: out }
}

function main () {
  const [, , scanPath, rootDir, destDir, limitArg] = process.argv
  const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'))
  const byFile = new Map()
  for (const it of scan.items) {
    if (it.score < T) continue
    if (!byFile.has(it.file)) byFile.set(it.file, [])
    byFile.get(it.file).push(it)
  }
  const limit = limitArg ? Number(limitArg) : Infinity
  const files = [...byFile.keys()].slice(0, limit)

  const results = []
  const TEST_RE = /(^|\/)(__tests__|__mocks__|e2e|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i
  for (const f of files) {
    if (TEST_RE.test(f)) {
      results.push({ file: f, applied: 0, skipped: byFile.get(f).map(i => ({ key: i.value, reason: 'test-file' })), keys: [] })
      continue
    }
    const { report, changed } = applyFile(f, byFile.get(f), rootDir)
    results.push(report)
    if (changed != null) {
      const dest = path.join(destDir, f)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      // restore the file's original encoding conventions
      let text = report.crlf ? changed.replace(/\r?\n/g, '\r\n') : changed
      if (report.hadBom) text = '\uFEFF' + text
      fs.writeFileSync(dest, text)
    }
  }

  const applied = results.reduce((s, r) => s + r.applied, 0)
  const filesChanged = results.filter(r => r.applied).length
  const skipped = results.flatMap(r => r.skipped)
  const reasons = {}
  for (const s of skipped) {
    const k = (s.reason || 'unknown').split(':')[0]
    reasons[k] = (reasons[k] ?? 0) + 1
  }
  const candidates = files.reduce((s, f) => s + byFile.get(f).length, 0)

  console.log(`files with candidates: ${files.length}`)
  console.log(`files rewritten:       ${filesChanged}`)
  console.log(`candidate edits:       ${candidates}`)
  console.log(`edits applied:         ${applied}`)
  console.log(`edits skipped:         ${skipped.length}`)
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
  const fatal = skipped.filter(s => /parse/.test(s.reason || ''))
  for (const s of fatal.slice(0, 6)) console.log(`  ! ${s.reason}`)

  fs.writeFileSync(path.join('out', 'codemod.json'), JSON.stringify({ applied, filesChanged, candidates, skipped: skipped.length, reasons, results }, null, 2))
  const tag = path.basename(destDir)
  fs.writeFileSync(path.join('out', `codemod-${tag}.json`), JSON.stringify({ tag, applied, filesChanged, candidates, skipped: skipped.length, reasons, results }, null, 2))
  console.log(`\nwrote out/codemod.json, out/codemod-${tag}.json`)
  const used = new Set()
  for (const r of results) for (const rec of r.records ?? []) if (rec.key) used.add(rec.key)
  const pruned = registry.prune(used)
  const frozen = registry.save()
  console.log(`keys frozen: ${frozen} (live ${pruned} in ${process.env.KEYS_FILE || 'out/keys.json'})`)
}

main()
