/**
 * Run every suite in one process.
 *
 * Three suites: core unit tests, adapters unit tests, extension integration tests. Each
 * one already avoids spawning (`node --test` forks per file, which this environment
 * denies), so importing them in sequence is enough. The TypeScript sources are compiled
 * first — a test run against a stale `.test/` directory is worse than no test run.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function compile(dirName) {
  const dir = path.join(repoRoot, 'packages', dirName)
  const configPath = path.join(dir, 'tsconfig.test.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) throw new Error(`cannot read ${configPath}`)
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, configPath)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const emit = program.emit()
  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(emit.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) {
    for (const d of errors.slice(0, 10)) console.error(ts.flattenDiagnosticMessageText(d.messageText, ' '))
    throw new Error(`${dirName}: test compilation failed`)
  }
}

const suites = [
  { name: 'core', dir: 'core' },
  { name: 'adapters', dir: 'adapters' },
  { name: 'vscode', dir: null },
]

for (const suite of suites) if (suite.dir) compile(suite.dir)

console.log('\n--- core + adapters ---')
await import(pathToFileURL(path.join(repoRoot, 'packages', 'core', 'test', 'run.mjs')).href)
await import(pathToFileURL(path.join(repoRoot, 'packages', 'adapters', 'test', 'run.mjs')).href)

console.log('\n--- extension integration ---')
const integration = path.join(repoRoot, 'packages', 'vscode', 'test', 'integration.mjs')
await import(pathToFileURL(integration).href)
