# Changelog

## 0.1.2

Fix: 0.1.1 still failed to activate on VS Code 1.98 with
`command 'i18nCodemod.scan' not found`, while 0.1.0's `typescript` error was gone.

This time the extension entry point itself was the problem. VS Code 1.98 activates an
extension by calling `require()` on its `main` file (`ExtensionService#loadCommonJSModule`
in `exthost.log`). The manifest said `"type": "module"`, so that call died with
`ERR_REQUIRE_ESM` before a single command was registered. The side bar still appeared —
`viewsWelcome` is a declarative contribution — which is why the extension looked installed
but dead.

- The extension now ships as CommonJS. `core` and `adapters` publish both flavours and are
  selected through the `import` / `require` conditions of their `exports`, so the CLI keeps
  its ESM build.
- Packaging vendors `dist-cjs` alongside `dist` and audits `require()` calls, not only
  `import` statements.
- Activation logs one line to stdout, so `exthost.log` carries proof that `activate()`
  finished.

## 0.1.1

Fix: the extension installed from a vsix failed to activate with
`command 'i18nCodemod.scan' not found`.

The syntax gate imported the `typescript` compiler, which was declared as a
devDependency. It resolved in the workspace and in every test, but the packager only
vendors `dependencies`, so activation threw `ERR_MODULE_NOT_FOUND` before any command was
registered — reported by VS Code as a missing command, with no stack trace.

- The syntax gate now parses with `@babel/parser` (already a runtime dependency); the
  TypeScript compiler is no longer shipped, saving ~10 MB.
- Packaging parses every emitted file and fails the build if a bare import is not vendored.
- A test asserts that every bare import in `core/src` is a declared dependency, so this
  class of bug cannot reach a user again.

## 0.1.0 — M1

First build that can rewrite a real project.

- Scan React/TSX and Vue 3 sources for hard-coded copy, with a per-string score and the
  rules that produced it.
- Rewrite through a gate stack: syntax before and after, offset fingerprint, overlapping
  ranges, and a veto list for console calls, style strings and already-translated keys.
- React rich text is extracted as one unit with `<Trans i18nKey values components>`;
  catalog values use the same `<0>{v0}</0>` numbering as the component props.
- Keys are structural and frozen in a registry: re-running against the same sources
  produces no new keys and renames nothing.
- Coverage report (overall, per directory, per file) and dead-key detection.
- CLI with the same engine: `scan`, `apply`, `report`, exits non-zero on coverage gates.
