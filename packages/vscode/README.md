# i18n Codemod

Extract hard-coded strings from your source into i18n catalogs — and get a coverage
number you can actually put in CI.

This is the M1 build: React/TSX and Vue 3 are supported first, and the rewrite is
gated so that a bad extraction cannot reach disk.

## Commands

| command | what it does |
| --- | --- |
| `i18n Codemod: Scan Workspace` | find hard-coded strings, populate the sidebar |
| `i18n Codemod: Extract All` | rewrite every accepted string, undoable with Ctrl+Z |
| `i18n Codemod: Extract Strings in This File` | rewrite just the active file (also on the code lens) |
| `i18n Codemod: Preview Extraction for This File` | diff view, nothing written |
| `i18n Codemod: Show Coverage Report` | coverage by directory and file, plus dead keys |
| `i18n Codemod: Why Was This (Not) Extracted?` | the score and every rule that fired |

## What it writes

```tsx
// before
<button title="刷新数据">刷新</button>

// after
<button title={t('app.pages.dashboard.title.refresh-data')}>{t('app.pages.dashboard.text.refresh')}</button>
```

Keys live in a registry (`out/keys.json` by default). Commit it: it is what keeps keys
stable across runs. Extracted copy goes to `i18nCodemod.catalogDir` when configured.

## Settings

- `i18nCodemod.threshold` (default `0.55`) — confidence cut-off. Lower catches more
  English strings, at the cost of false positives.
- `i18nCodemod.namespace` (default `app`)
- `i18nCodemod.keysFile` (default `out/keys.json`)
- `i18nCodemod.catalogDir` — locale directory for extracted copy
- `i18nCodemod.aliasUseT` / `aliasI18n` / `aliasTrans` — import paths for the injected
  `useT` hook, the `i18n` singleton and `<Trans>`

## Safety

Every file passes a syntax gate before and after rewriting, an offset fingerprint check,
and a veto list (console calls, style strings, already-translated keys, technical
literals). Files that fail any gate are left untouched. Edits go through the editor's
undo stack.

## Known limits in this build

- Vue rich text (`<i18n-t>`) is not generated yet — only React `<Trans>`.
- English-only projects get lower recall than Chinese ones at the same threshold.
- The key registry is per-workspace; monorepos with several apps share one namespace
  unless you point `keysFile` elsewhere.
