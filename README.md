# i18n Codemod

Find hard-coded copy in a React or Vue 3 codebase, rewrite it into translation calls,
and tell you how much is still untranslated — from the editor, the terminal, or not at all.

The claim this project makes is narrow: **a rewrite you can review in ten minutes and
re-run without surprises.** Everything below exists to support that.

```
$ i18n-codemod scan    corpus/vue-vben-admin     # 1386 files, ~1.1 s, 5721 candidates
$ i18n-codemod apply   corpus/vue-vben-admin     # 247 files, 2295 edits, 1277 keys
$ i18n-codemod report  corpus/vue-vben-admin     # coverage 97.8%, 0 dead keys
```

## What it does

- **Extraction with a reason.** Every candidate carries a score and the rules that moved
  it (CJK, word count, JSX position, already-wrapped, class list, identifier). Nothing is
  a black box you have to take on faith.
- **Rewrites behind seven gates.** Syntax before and after, an offset fingerprint, an
  overlap check, a veto list (console, styles, keys, `Bearer` tokens), a per-file
  transaction, and a post-parse on the result. A file that fails any gate is left
  untouched.
- **Structural, frozen keys.** `app.<scope>.<role>.<slug>` — readable, stable, never a
  content hash. Re-running on the same sources produces no new keys and renames nothing.
- **Rich text as one unit.** `<a>{owner}</a> 发布在 <a>{href}</a>` becomes a single
  message with numbered placeholders and a `<Trans>` component whose props share the same
  numbering as the catalog value.
- **Coverage you can put in CI.** Per directory, per file, worst-first, plus dead keys.
  `report --min-coverage 90` exits non-zero.

## Packages

| Package | What it is |
| --- | --- |
| `packages/core` (`@i18n-codemod/core`) | Pure TypeScript engine. No `vscode` import anywhere — the same code runs in the extension, the CLI and CI. |
| `packages/adapters` (`@i18n-codemod/adapters`) | Which `t` to import, where catalogs live, and how to tell a Next project from a Vue one (including monorepos, where the i18n library lives in `apps/*`). |
| `packages/cli` (`@i18n-codemod/cli`) | `scan`, `apply`, `report`. Exit codes meant for pipelines. |
| `packages/vscode` | The extension: tree view, code lens, preview diff, apply through a `WorkspaceEdit`, coverage report. |

`spike/` is the measurement harness from M0 — the scripts that produced the numbers in
`docs/03-Spike结果.md`. It is kept because the numbers should be reproducible, not
because it ships.

## Getting started

```bash
pnpm install --ignore-scripts
pnpm -r --filter ./packages/** run build

node scripts/build.mjs
node scripts/test.mjs

node packages/cli/dist/index.js scan   <project>
node packages/cli/dist/index.js apply  <project> --dry-run
node packages/cli/dist/index.js apply  <project> --keys i18n/keys.json --catalog i18n
node packages/cli/dist/index.js report <project> --min-coverage 80
```

`--adapter auto|next-intl|react-i18next|vue-i18n|generic` overrides framework detection;
`auto` reads `package.json` at the root and one workspace level down.

The extension is built with `node packages/vscode/scripts/package.mjs`, which produces
`packages/vscode/i18n-codemod-0.1.0.vsix`.

## Supported today

| | Scan | Rewrite | Rich text |
| --- | --- | --- | --- |
| React / TSX (`jsx-text`, attributes, props, call args) | yes | `t()` + `useT()` or `i18n.t()` | `<Trans>` |
| Vue 3 SFC (`template` text, attributes, `script setup`) | yes | `$t()` / `:attr` / `useI18n()` | not yet |
| Plain TS/JS strings | yes | `t()` at module scope | — |

Not supported yet: Vue `<i18n-t>` rich text, Options API components, Angular/Svelte,
`.vue` template literals inside `v-for` conditions.

## Docs

- [技术要求与验证方案](docs/02-Spike验证方案.md)
- [M0 spike results](docs/03-Spike结果.md) — where the precision/recall numbers come from
- [Decisions](docs/04-决策记录.md) — key naming, sentence modelling, memory
- [M1 delivery](docs/06-M1-交付说明.md) — what is built, how it is verified, what is missing
- [安装与使用](docs/07-安装与使用.md) — install the vsix, first scan, settings, troubleshooting
- [仓库与版本控制](docs/08-仓库与版本控制.md) — what belongs in git, what is a release asset

## License

MIT
