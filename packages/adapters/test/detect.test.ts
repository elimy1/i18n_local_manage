import { describe, expect, it } from './_expect.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADAPTER_IDS, adapterFromDeps, catalogPath, getAdapter, resolveAdapter } from '../src/index.js'

describe('adapter detection', () => {
  it('picks the most specific adapter for a Next project', () => {
    // "next" alone is ambiguous; next-intl must win over bare react.
    expect(adapterFromDeps({ next: '14.0.0', react: '18.0.0', 'next-intl': '3.0.0' }).id).toBe('next-intl')
  })

  it('detects react-i18next from devDependencies too', () => {
    expect(adapterFromDeps({ react: '18.0.0', i18next: '23.0.0', 'react-i18next': '13.0.0' }).id).toBe('react-i18next')
  })

  it('detects vue-i18n', () => {
    expect(adapterFromDeps({ vue: '3.4.0', 'vue-i18n': '9.0.0' }).id).toBe('vue-i18n')
  })

  it('falls back to generic for an unknown project', () => {
    expect(adapterFromDeps({}).id).toBe('generic')
    expect(adapterFromDeps({ lodash: '4.0.0' }).id).toBe('generic')
  })
})

describe('adapter resolution', () => {
  it('reads package.json from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.4.0', 'vue-i18n': '^9.10.0' } }),
    )
    expect(resolveAdapter(dir, 'auto').id).toBe('vue-i18n')
  })

  it('an explicit id overrides detection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'vue-i18n': '9' } }))
    // Guessing wrong should be correctable; silently ignoring the flag is not.
    expect(resolveAdapter(dir, 'react-i18next').id).toBe('react-i18next')
  })

  it('a project with no package.json resolves to generic instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))
    expect(resolveAdapter(dir, 'auto').id).toBe('generic')
  })

  it('finds the i18n library inside a monorepo workspace', () => {
    // Root manifests rarely declare the i18n library; the app package does.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }))
    fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'apps', 'web', 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.4.0', 'vue-i18n': '^9.10.0' } }),
    )
    expect(resolveAdapter(dir, 'auto').id).toBe('vue-i18n')
  })

  it('rejects an unknown id with a list of valid ones', () => {
    let message = ''
    try {
      getAdapter('angular')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('unknown adapter')
    expect(message).toContain(ADAPTER_IDS[0]!)
  })
})

describe('catalog paths', () => {
  it('puts copy next to the project for each framework', () => {
    expect(catalogPath(getAdapter('vue-i18n'), '/p')).toContain(path.join('src', 'locales', 'zh-CN.json'))
    expect(catalogPath(getAdapter('react-i18next'), '/p')).toContain(path.join('public', 'locales', 'en.json'))
    expect(catalogPath(getAdapter('next-intl'), '/p')).toContain(path.join('messages', 'en.json'))
  })
})
