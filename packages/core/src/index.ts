export * from './types.js'
export { collectFiles, readSource, lineCol, readJson, writeJson, ensureDir, TEST_FILE_RE, percentile, type SourceFile } from './fsx.js'
export { collect, collectScriptPool, collectVuePool, parseJs, walk, hasCjk, normalizeSpace, serializeRich, TRANSLATABLE_ATTRS, MESSAGE_CALLEES, UI_COPY_KEYS } from './parse.js'
export { classify, THRESHOLD, type Classified } from './detect.js'
export { scanProject, scanProjectWithProgress, scanSource, readFileSource } from './scan.js'
export { KeyRegistry, scopePath, roleOf, slugOf, DEFAULT_NS } from './keys.js'
export { applyFile, planFile, rewriteProject, syntaxCheck, veto, exportCatalogs, type PlannedEdit, type FilePlan, type ApplyOutcome } from './rewrite.js'
export { coverageFromScan, findDeadKeys, type CoverageOptions } from './coverage.js'
export {
  catalogFiles,
  readCatalog,
  patchCatalog,
  writeCatalogs,
  flattenCatalog,
  type CatalogFile,
  type CatalogPatch,
  type CatalogOptions,
  type CatalogEditResult,
  type CatalogFormat,
} from './catalog.js'
