/**
 * Integration harness: loads the built extension against a stubbed `vscode`, points it at
 * a throwaway copy of `test/fixture`, and walks the two paths that matter — scan, then
 * rewrite — asserting on the files that end up on disk.
 *
 * The `vscode` module is injected with a resolve hook instead of a node_modules shim
 * because pnpm prunes unknown packages; a stub that vanishes turns this into a false
 * green. Node >= 22.15 for `registerHooks`.
 *
 * Run: node test/integration.mjs   (after `npm run build`)
 */
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const stubPath = path.join(here, 'vscode-stub.mjs')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: pathToFileURL(stubPath).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const vscode = await import(pathToFileURL(stubPath).href)

// The extension ships as CommonJS (VS Code 1.98 loads `main` with require(), and an ESM
// entry dies with ERR_REQUIRE_ESM). Its `require('vscode')` goes through the CJS loader,
// which the ESM resolve hook above never sees.
const loadModule = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode
  return loadModule.call(this, request, parent, isMain)
}
const { state } = vscode

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-ext-'))
copyDir(path.join(here, 'fixture'), workRoot)

state.folders = [{ uri: vscode.Uri.file(workRoot), name: 'fixture', index: 0 }]
state.config = {
  'i18nCodemod.threshold': 0.5,
  'i18nCodemod.namespace': 'app',
  'i18nCodemod.keysFile': 'out/keys.json',
  'i18nCodemod.catalogDir': 'locales',
}
state.commands['markdown.showPreview'] = async () => {}

const ext = await import(pathToFileURL(path.join(pkgRoot, 'dist', 'extension.js')).href)
const context = { subscriptions: [], globalStorageUri: vscode.Uri.file(path.join(workRoot, '.storage')), extensionUri: vscode.Uri.file(pkgRoot) }

console.log(`\nfixture: ${workRoot}\n`)

ext.activate(context)
check('activate registers commands', Object.keys(state.commands).length >= 6, Object.keys(state.commands).join(', '))
check('status bar shows a placeholder', state.statusBar.length === 1 && state.statusBar[0].text.includes('i18n'))
check('tree view created', state.treeViews.length === 1)

/* --- scan --- */
await vscode.commands.executeCommand('i18nCodemod.scan')
const treeView = state.treeViews[0]
check('scan populates the tree', /strings/.test(treeView.description), treeView.description)
check('scan reports through the output channel', state.log.some((l) => l.startsWith('scan done')), state.log.join(' | '))

const tree = treeView.treeDataProvider
const roots = tree.getChildren()
check('tree has a summary node', roots[0]?.type === 'summary')
const summary = roots[0]
check('summary counts accepted strings', summary.accepted >= 6, JSON.stringify(summary))
const fileNodes = roots.filter((n) => n.type === 'file')
check('tree groups candidates by file', fileNodes.length >= 3, fileNodes.map((f) => f.file).join(', '))
const firstFile = fileNodes.find((f) => f.file.includes('index.tsx'))
check('tsx file present', Boolean(firstFile))
const leaves = tree.getChildren(firstFile)
check('file node has candidate children', leaves.length > 0)
const leafItem = tree.getTreeItem(leaves[0])
check('candidate leaf opens on click', leafItem.command?.command === 'i18nCodemod.revealCandidate')
check('candidate tooltip explains the score', String(leafItem.tooltip?.value ?? '').includes('score'))

/* --- code lens --- */
const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workRoot, 'src/pages/dashboard/index.tsx')))
const lenses = state.codeLensProviders[0].provideCodeLenses(doc)
check('code lens offers extraction', lenses.length === 2 && lenses[0].command.title.includes('Extract'), JSON.stringify(lenses.map((l) => l.command?.title)))

/* --- apply --- */
const before = read(workRoot, 'src/pages/dashboard/index.tsx')
state.warningAnswer = 'Rewrite'
await vscode.commands.executeCommand('i18nCodemod.applyAll')
check('no unhandled error surfaced', state.errors.length === 0, state.errors.join(' | '))

const afterTsx = read(workRoot, 'src/pages/dashboard/index.tsx')
check('tsx was rewritten', afterTsx !== before)
check('tsx injects the useT import', afterTsx.includes("import { useT } from '@/i18n/react'"), afterTsx.slice(0, 200))
check('tsx calls t()', /\{t\("/.test(afterTsx) || /t\("/.test(afterTsx))
check('tsx keeps the Chinese copy out of JSX', !afterTsx.includes('仪表盘'), afterTsx)

const afterVue = read(workRoot, 'src/components/UserCard.vue')
check('vue template uses $t', afterVue.includes('$t('), afterVue)
check('vue bound attribute uses :title', /:title="\$t\('app\.[^']+'\)"/.test(afterVue), afterVue)

const keysPath = path.join(workRoot, 'out/keys.json')
check('key registry written', fs.existsSync(keysPath))
const registry = JSON.parse(fs.readFileSync(keysPath, 'utf8'))
const keyList = Object.values(registry.keys ?? {})
check('registry holds frozen keys', keyList.length >= 6, `${keyList.length}`)
check('keys are namespaced and readable', keyList.every((k) => k.startsWith('app.') && !/\.c[0-9a-f]{6}$/.test(k)), keyList.slice(0, 3).join(', '))

const catalogPath = path.join(workRoot, 'locales/zh-CN.json')
check('catalog exported', fs.existsSync(catalogPath))
if (fs.existsSync(catalogPath)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const values = Object.values(catalog)
  check('catalog keeps the source copy', values.some((v) => String(v).includes('仪表盘')), values.slice(0, 3).join(' | '))
  check('catalog keys match the registry', Object.keys(catalog).every((k) => keyList.includes(k)))
}

/* --- idempotency: second run must not invent new keys --- */
const keysBefore = fs.readFileSync(keysPath, 'utf8')
await vscode.commands.executeCommand('i18nCodemod.clearCache')
await vscode.commands.executeCommand('i18nCodemod.scan')
state.warningAnswer = 'Rewrite'
await vscode.commands.executeCommand('i18nCodemod.applyAll')
const keysAfter = fs.readFileSync(keysPath, 'utf8')
check('second pass leaves the registry untouched', keysBefore === keysAfter)

/* --- single file preview path --- */
// A file created after the workspace scan, so it is still untranslated here.
fs.writeFileSync(
  path.join(workRoot, 'src/utils/labels.ts'),
  [
    'export function labelFor(kind: string): string {',
    "  if (kind === 'create') return '新建项目'",
    "  if (kind === 'remove') return '删除所选'",
    "  return `未知类型（${kind}）`",
    '}',
    '',
  ].join('\n'),
)
const tsDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workRoot, 'src/utils/labels.ts')))
state.activeEditor = { document: tsDoc, selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)), revealRange: () => {} }
const tsBefore = read(workRoot, 'src/utils/labels.ts')
await vscode.commands.executeCommand('i18nCodemod.extractFile')
const tsAfter = read(workRoot, 'src/utils/labels.ts')
check('extractFile rewrites the active document', tsAfter !== tsBefore, tsAfter.slice(0, 160))
check('extractFile imports what it calls', /import \{ i18n \}/.test(tsAfter) || /import \{ useT \}/.test(tsAfter), tsAfter.slice(0, 200))

console.log('')
if (state.errors.length) {
  console.log('errors surfaced by the extension:')
  for (const e of state.errors) console.log(`  - ${e}`)
}
if (failures) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
