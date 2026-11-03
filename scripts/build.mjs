/**
 * Build every package in one process.
 *
 * `pnpm -r run build` would work on a normal machine, but each script run spawns a
 * shell, and this project is developed in an environment where spawned processes with
 * piped stdio are denied. Driving the TypeScript API directly keeps the build working
 * there, and it is also faster: one compiler load, four programs, shared libs.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Dependency order matters: cli and vscode resolve their workspace deps from dist.
const packages = ['core', 'adapters', 'cli', 'vscode']

let failed = 0
for (const name of packages) {
  const dir = path.join(repoRoot, 'packages', name)
  const configPath = path.join(dir, 'tsconfig.build.json')
  const started = Date.now()

  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    report(name, [read.error])
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
    report(name, diagnostics)
    failed++
  } else {
    console.log(`  ${name.padEnd(9)} ok  ${Date.now() - started}ms`)
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
