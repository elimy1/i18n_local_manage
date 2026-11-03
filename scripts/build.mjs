/**
 * Build every package in one process.
 *
 * `pnpm -r run build` would work on a normal machine, but each script run spawns a
 * shell, and this project is developed in an environment where spawned processes with
 * piped stdio are denied. Driving the TypeScript API directly keeps the build working
 * there, and it is also faster: one compiler load, four programs, shared libs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Dependency order matters: cli and vscode resolve their workspace deps from dist.
 *
 * core and adapters are built twice. The CLI imports them as ESM; the VS Code extension
 * is CommonJS, because VS Code 1.98 loads extensions with `require()` and throws
 * `ERR_REQUIRE_ESM` on an ESM `main` — the 0.1.1 activation failure. Both flavours are
 * published through the `import` / `require` conditions of the package `exports`.
 */
const targets = [
  { name: 'core', config: 'tsconfig.build.json' },
  { name: 'core', config: 'tsconfig.cjs.json', cjs: true },
  { name: 'adapters', config: 'tsconfig.build.json' },
  { name: 'adapters', config: 'tsconfig.cjs.json', cjs: true },
  { name: 'cli', config: 'tsconfig.build.json' },
  { name: 'vscode', config: 'tsconfig.build.json' },
]

let failed = 0
for (const target of targets) {
  const dir = path.join(repoRoot, 'packages', target.name)
  const configPath = path.join(dir, target.config)
  const started = Date.now()

  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    report(target.name, [read.error])
    failed++
    continue
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, configPath)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const emit = program.emit()
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emit.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)

  if (diagnostics.length) {
    report(target.name, diagnostics)
    failed++
  } else {
    // A `type: module` package treats every .js inside it as ESM, including dist-cjs.
    // The nested manifest is what tells node these files are CommonJS.
    if (target.cjs) {
      const cjsDir = path.join(dir, 'dist-cjs')
      fs.mkdirSync(cjsDir, { recursive: true })
      fs.writeFileSync(path.join(cjsDir, 'package.json'), '{"type":"commonjs"}\n')
    }
    const label = target.cjs ? `${target.name} (cjs)` : target.name
    console.log(`  ${label.padEnd(13)} ok  ${Date.now() - started}ms`)
  }
}

console.log(failed ? `\n${failed} package(s) failed` : '\nall packages built')
process.exit(failed ? 1 : 0)

function report(name, diagnostics) {
  console.error(`  ${name} failed`)
  for (const d of diagnostics.slice(0, 20)) {
    const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : ''
    console.error(`    ${where} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
}
