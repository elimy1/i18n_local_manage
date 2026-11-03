// Runs every compiled test file in one process.
//
// `node --test <dir>` is not usable here: the runner spawns one child process
// per file, and the sandbox denies piped stdio spawns (EPERM). Importing the
// compiled tests into a single process gives the same node:test reporter
// without forking anything.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '../.test/test')

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()

for (const file of files) {
  await import(pathToFileURL(path.join(dir, file)).href)
}
