/**
 * Build a .vsix without a bundler.
 *
 * esbuild/vite cannot run in this environment (they spawn child processes with piped
 * stdio, which the sandbox denies), so instead of bundling we assemble a staging folder
 * that looks exactly like a published extension: compiled dist, the workspace core
 * package vendored under node_modules, and the transitive runtime dependency closure
 * copied in. That is also closer to what vsce expects, so it is a smaller step from
 * "works here" to "works from the Marketplace".
 *
 * Run: node scripts/package.mjs [--skip-build]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const repoRoot = path.resolve(pkgRoot, '..', '..')
const coreRoot = path.resolve(repoRoot, 'packages', 'core')
const adaptersRoot = path.resolve(repoRoot, 'packages', 'adapters')
const nodeModules = path.join(repoRoot, 'node_modules')
const stage = path.join(pkgRoot, '.stage')
const tsc = path.join(nodeModules, 'typescript', 'bin', 'tsc')
const vsce = path.join(nodeModules, '@vscode', 'vsce', 'vsce')

const skipBuild = process.argv.includes('--skip-build')

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else if (entry.isSymbolicLink()) fs.copyFileSync(fs.realpathSync(src), dst)
    else fs.copyFileSync(src, dst)
  }
}

/** Every package a dependency tree needs at runtime, resolved from the hoisted root. */
function runtimeClosure(roots) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const dir = path.join(nodeModules, name)
    if (!fs.existsSync(dir)) continue
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep)
  }
  return [...seen]
}

if (!skipBuild) {
  run(process.execPath, [tsc, '-p', path.join(coreRoot, 'tsconfig.build.json')], coreRoot)
  run(process.execPath, [tsc, '-p', path.join(pkgRoot, 'tsconfig.build.json')], pkgRoot)
}

rm(stage)
fs.mkdirSync(stage, { recursive: true })

/* --- manifest: no workspace protocol, no dev scripts --- */
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
delete manifest.scripts
delete manifest.devDependencies
manifest.dependencies ??= {}
// Workspace packages are vendored into node_modules below, so the published manifest
// must not ask the Marketplace to resolve a protocol it cannot see.
for (const dep of Object.keys(manifest.dependencies)) {
  if (dep.startsWith('@i18n-codemod/')) delete manifest.dependencies[dep]
}
manifest.repository = manifest.repository ?? { type: 'git', url: 'https://github.com/i18n-codemod/i18n-codemod.git' }
manifest.bugs = { url: 'https://github.com/i18n-codemod/i18n-codemod/issues' }
manifest.homepage = 'https://github.com/i18n-codemod/i18n-codemod#readme'
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

copyDir(path.join(pkgRoot, 'dist'), path.join(stage, 'dist'))
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
  const src = path.join(pkgRoot, file)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, file))
}

/* --- vendor workspace packages: the extension imports them at runtime --- */
const vendored = [{ name: 'core', root: coreRoot }, { name: 'adapters', root: adaptersRoot }]
const vendoredDeps = []
for (const pkg of vendored) {
  const dir = path.join(stage, 'node_modules', '@i18n-codemod', pkg.name)
  fs.mkdirSync(dir, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8'))
  delete manifest.scripts
  delete manifest.devDependencies
  // Workspace links inside the closure are vendored explicitly, not chased by name.
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep.startsWith('@i18n-codemod/')) delete manifest.dependencies[dep]
    else vendoredDeps.push(dep)
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  copyDir(path.join(pkg.root, 'dist'), path.join(dir, 'dist'))
  // The extension is CommonJS, so it consumes the `require` condition of these packages;
  // both flavours have to be inside the vsix or activation dies with ERR_MODULE_NOT_FOUND.
  if (fs.existsSync(path.join(pkg.root, 'dist-cjs'))) {
    copyDir(path.join(pkg.root, 'dist-cjs'), path.join(dir, 'dist-cjs'))
  }
}

/* --- third-party runtime closure --- */
const closure = runtimeClosure(vendoredDeps)
let bytes = 0
for (const name of closure) {
  const from = path.join(nodeModules, name)
  if (!fs.existsSync(from)) {
    console.warn(`warn: missing dependency ${name}`)
    continue
  }
  const to = path.join(stage, 'node_modules', name)
  copyDir(from, to)
  const manifestPath = path.join(to, 'package.json')
  if (fs.existsSync(manifestPath)) bytes += fs.statSync(manifestPath).size
}
console.log(`vendored ${closure.length} runtime packages: ${closure.join(', ')}`)

const ignore = ['.stage', 'test', 'scripts', 'src', 'tsconfig*.json', '*.map', 'node_modules/.bin']
fs.writeFileSync(path.join(stage, '.vscodeignore'), `${ignore.join('\n')}\n`)

/* --- runtime import audit ---
 * A dependency that is imported at runtime but only declared in devDependencies compiles
 * fine and then makes the installed extension fail to activate with "command not found".
 * That is exactly how `typescript` shipped in 0.1.0: the syntax gate imported it, the
 * packager only walked `dependencies`, and VS Code reported a missing command. Fail the
 * build instead of the user's activation.
 *
 * Parsed, not grepped: core emits code strings that contain `import { t } from '@/i18n'`,
 * and a text scan mistakes those for real imports.
 */
const { parse: babelParse } = await import(pathToFileURL(path.join(nodeModules, '@babel/parser', 'lib', 'index.js')).href)
function importSpecifiers(code) {
  const ast = babelParse(code, { sourceType: 'unambiguous', plugins: ['jsx', 'typescript'], errorRecovery: true })
  const specs = []
  const stack = [ast.program]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      if (node.source) specs.push(node.source.value)
    }
    if (node.type === 'ImportExpression' && node.source?.type === 'StringLiteral') specs.push(node.source.value)
    if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments[0]?.type === 'StringLiteral') {
      specs.push(node.arguments[0].value)
    }
    // CommonJS output: require('x') never shows up as an ImportDeclaration.
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments[0]?.type === 'StringLiteral'
    ) {
      specs.push(node.arguments[0].value)
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) stack.push(...child)
      else if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child)
    }
  }
  return specs
}

function auditRuntimeImports() {
  const missing = new Map()
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const rel of walk(dir, dir)) {
      if (!rel.endsWith('.js')) continue
      const full = path.join(dir, rel)
      let specs
      try {
        specs = importSpecifiers(fs.readFileSync(full, 'utf8'))
      } catch (e) {
        throw new Error(`${path.relative(stage, full)}: cannot parse for import audit — ${e.message}`)
      }
      for (const spec of specs) {
        if (typeof spec !== 'string' || spec.startsWith('.') || spec.startsWith('node:') || spec === 'vscode') continue
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!fs.existsSync(path.join(stage, 'node_modules', name))) {
          if (!missing.has(name)) missing.set(name, new Set())
          missing.get(name).add(path.relative(stage, full))
        }
      }
    }
  }
  scan(path.join(stage, 'dist'))
  scan(path.join(stage, 'node_modules', '@i18n-codemod'))
  if (missing.size) {
    const lines = [...missing].map(([name, files]) => `  ${name}  ← ${[...files].slice(0, 3).join(', ')}`)
    throw new Error(`runtime imports missing from the package:\n${lines.join('\n')}`)
  }
}
auditRuntimeImports()


/* --- package ---
 * vsce refuses to spawn npm in this sandbox once a package has dependencies, so we let it
 * produce the manifest from a dependency-free pass and then re-zip the archive ourselves
 * with the vendored node_modules included. A .vsix is a zip; nothing magical happens in
 * between, and doing it here keeps the build reproducible without a bundler.
 */
const out = path.join(pkgRoot, `i18n-codemod-${manifest.version}.vsix`)
const baseVsix = path.join(stage, '..', '.base.vsix')
for (const f of [out, baseVsix]) if (fs.existsSync(f)) fs.unlinkSync(f)

run(process.execPath, [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--out', baseVsix], stage)

const { default: yauzl } = await import(pathToFileURL(path.join(nodeModules, 'yauzl', 'index.js')).href)
const { default: yazl } = await import(pathToFileURL(path.join(nodeModules, 'yazl', 'index.js')).href)

const rootXml = new Map()
await new Promise((resolve, reject) => {
  yauzl.open(baseVsix, { lazyEntries: true }, (err, zip) => {
    if (err) return reject(err)
    zip.on('entry', (entry) => {
      if (entry.fileName.endsWith('.xml') && !entry.fileName.includes('/')) {
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e)
          const chunks = []
          stream.on('data', (c) => chunks.push(c))
          stream.on('end', () => {
            rootXml.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      } else {
        zip.readEntry()
      }
    })
    zip.on('end', resolve)
    zip.on('error', reject)
    zip.readEntry()
  })
})

function walk(dir, base = dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full, base))
    else files.push(path.relative(base, full))
  }
  return files
}

const zip = new yazl.ZipFile()
for (const [name, buf] of rootXml) zip.addBuffer(buf, name)
let packed = 0
let packedBytes = 0
for (const rel of walk(stage)) {
  const relPosix = rel.split(path.sep).join('/')
  if (relPosix === '.vscodeignore') continue
  packed++
  packedBytes += fs.statSync(path.join(stage, rel)).size
  zip.addFile(path.join(stage, rel), `extension/${relPosix}`)
}
zip.end()

await new Promise((resolve, reject) => {
  const ws = fs.createWriteStream(out)
  ws.on('close', resolve)
  ws.on('error', reject)
  zip.outputStream.pipe(ws)
})

const size = (fs.statSync(out).size / 1024 / 1024).toFixed(2)
console.log(`\npacked ${packed} files (${(packedBytes / 1024 / 1024).toFixed(2)} MB raw) → ${path.basename(out)} (${size} MB)`)
fs.unlinkSync(baseVsix)
