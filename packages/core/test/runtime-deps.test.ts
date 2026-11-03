/**
 * Runtime dependencies must be declared as `dependencies`, not `devDependencies`.
 *
 * Regression for 0.1.0: `rewrite.ts` imported `typescript` for the syntax gate. It resolved
 * in the workspace and in every test, but the packager only vendors `dependencies`, so the
 * installed extension threw ERR_MODULE_NOT_FOUND during activation and VS Code reported
 * `command 'i18nCodemod.scan' not found` — a failure mode with no stack trace and no hint.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { describe, expect, it } from './_expect.js'

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
// Compiled to .test/test/*.js, so the package root is two levels above .test/src.
const pkg = JSON.parse(fs.readFileSync(path.resolve(srcRoot, '..', '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

function specifiersIn(code: string): string[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  const out: string[] = []
  const stack: any[] = [ast.program]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      if (node.source) out.push(node.source.value)
    }
    if (node.type === 'ImportExpression' && node.source?.type === 'StringLiteral') out.push(node.source.value)
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) stack.push(...child)
      else if (child && typeof child === 'object' && typeof child.type === 'string') stack.push(child)
    }
  }
  return out
}

function runtimeImports(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of fs.readdirSync(srcRoot)) {
    if (!file.endsWith('.ts')) continue
    for (const spec of specifiersIn(fs.readFileSync(path.join(srcRoot, file), 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
      if (!found.has(name)) found.set(name, [])
      found.get(name)!.push(file)
    }
  }
  return found
}

describe('runtime dependency declarations', () => {
  it('every bare import in src is a declared dependency', () => {
    const deps = pkg.dependencies ?? {}
    const undeclared = [...runtimeImports()]
      .filter(([name]) => !deps[name])
      .map(([name, files]) => `${name} (${[...new Set(files)].join(', ')})`)
    expect(undeclared).toEqual([])
  })

  it('does not import the TypeScript compiler at runtime', () => {
    // 10 MB of compiler in a vsix, to parse one file, and it was the 0.1.0 activation bug.
    expect(runtimeImports().has('typescript')).toBe(false)
  })
})
