# Changelog

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
