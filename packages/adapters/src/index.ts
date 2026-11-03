/**
 * Framework adapters.
 *
 * The engine is deliberately framework-blind: it collects candidates, scores them and
 * rewrites them through one gate stack. What changes between projects is small but
 * load-bearing — where `t` comes from, where catalog files live, which package means
 * "this is a React app". That is all an adapter is.
 *
 * Keeping this in its own package (rather than in core) is what lets a project ship a
 * custom adapter without forking the engine, and lets the CLI and the extension agree
 * on one answer for "which adapter is this".
 */
import fs from 'node:fs'
import path from 'node:path'

export interface AdapterAliases {
  /** module that exports the React hook used inside components */
  useT: string
  /** module that exports the imperative singleton used at module scope */
  i18n: string
  /** module that exports the rich-text component */
  trans: string
}

export interface Adapter {
  id: string
  label: string
  /** dependencies that imply this adapter; checked in order, most specific first */
  packages: string[]
  aliases: AdapterAliases
  /** default place extracted copy is written to */
  catalog: { dir: string; locale: string; extension: 'json' | 'yaml' }
}

const REACT_I18NEXT: Adapter = {
  id: 'react-i18next',
  label: 'React + react-i18next',
  packages: ['react-i18next', 'i18next'],
  aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
  catalog: { dir: 'public/locales', locale: 'en', extension: 'json' },
}

const NEXT_INTL: Adapter = {
  id: 'next-intl',
  label: 'Next.js + next-intl',
  packages: ['next-intl'],
  aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
  catalog: { dir: 'messages', locale: 'en', extension: 'json' },
}

const VUE_I18N: Adapter = {
  id: 'vue-i18n',
  label: 'Vue 3 + vue-i18n',
  packages: ['vue-i18n'],
  aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
  catalog: { dir: 'src/locales', locale: 'zh-CN', extension: 'json' },
}

const GENERIC: Adapter = {
  id: 'generic',
  label: 'Generic (framework-neutral)',
  packages: [],
  aliases: { useT: '@/i18n/react', i18n: '@/i18n', trans: 'react-i18next' },
  catalog: { dir: 'locales', locale: 'en', extension: 'json' },
}

export const ADAPTERS: readonly Adapter[] = [NEXT_INTL, REACT_I18NEXT, VUE_I18N, GENERIC]
export const ADAPTER_IDS = ADAPTERS.map((a) => a.id)

export function getAdapter(id: string): Adapter {
  const found = ADAPTERS.find((a) => a.id === id)
  if (!found) throw new Error(`unknown adapter "${id}" (expected one of: ${ADAPTER_IDS.join(', ')})`)
  return found
}

/** Pick an adapter from a dependency map. Pure, so it is cheap to test. */
export function adapterFromDeps(deps: Record<string, string>): Adapter {
  for (const adapter of ADAPTERS) {
    if (adapter.packages.some((p) => p in deps)) return adapter
  }
  return GENERIC
}

/**
 * Read dependencies from the root manifest and from the manifests one workspace level
 * down. A monorepo almost never declares its i18n library at the root — the app package
 * does — and reporting "generic" for a Vue monorepo is the kind of wrong answer that
 * makes people distrust detection.
 */
export function collectDeps(root: string): Record<string, string> {
  const deps: Record<string, string> = {}
  const read = (dir: string): void => {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      Object.assign(deps, json.devDependencies ?? {}, json.dependencies ?? {})
    } catch {
      /* no manifest here — that is a valid state, not an error */
    }
  }
  read(root)
  for (const group of ['apps', 'packages', 'playground', 'examples']) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, group), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) read(path.join(root, group, entry.name))
    }
  }
  return deps
}

/**
 * Resolve the adapter for a project root.
 *
 * `auto` reads package.json. An explicit id always wins: guessing wrong is cheap to
 * correct, but silently ignoring a user's choice is not.
 */
export function resolveAdapter(root: string, requested: string | undefined): Adapter {
  if (requested && requested !== 'auto') return getAdapter(requested)
  return adapterFromDeps(collectDeps(root))
}

/** Default catalog path for an adapter: `<dir>/<locale>.<ext>` under the project root. */
export function catalogPath(adapter: Adapter, root: string): string {
  return path.join(root, adapter.catalog.dir, `${adapter.catalog.locale}.${adapter.catalog.extension}`)
}
