export type FrameworkKind = 'react' | 'vue' | 'plain'

export type CandidateKind =
  | 'jsx-text'
  | 'jsx-sentence'
  | 'jsx-rich'
  | 'jsx-attr'
  | 'vue-text'
  | 'vue-sentence'
  | 'vue-attr'
  | 'obj-prop'
  | 'call-arg'
  | 'string-literal'
  | 'template-literal'

export type SourceLang = 'js' | 'ts' | 'jsx' | 'tsx' | 'vue'

export interface RichValue {
  name: string
  code: string
}

export interface RichTag {
  open: string
}

export interface RichText {
  template: string
  values: RichValue[]
  tags: RichTag[]
}

export type Part =
  | { type: 'text'; value: string }
  | { type: 'expr'; code: string }
  | { type: 'element'; tag: string; open: string; children: Part[] }
  | { type: 'opaque' }

export interface CandidateMeta {
  attrName?: string
  attrKind?: string
  propName?: string
  callee?: string
  varName?: string
  wrapped?: boolean
  hasExpr?: boolean
  exprCount?: number
  parts?: Part[]
  rich?: RichText
  [key: string]: unknown
}

export interface Candidate {
  id: string
  file: string
  start: number
  end: number
  line: number
  column: number
  kind: CandidateKind
  value: string
  raw: string
  lang: SourceLang
  meta: CandidateMeta
}

export interface Decision {
  candidate: Candidate
  translatable: boolean
  score: number
  reasons: string[]
}

export interface ScanOptions {
  root: string
  threshold?: number
  include?: (rel: string) => boolean
  maxFiles?: number
}

export interface FileTiming {
  file: string
  bytes: number
  ms: number
  pool: number
  accepted: number
}

export interface ScanResult {
  root: string
  files: number
  pool: number
  accepted: number
  parseErrors: { file: string; error: string }[]
  timings: {
    walkMs: number
    parseMs: number
    detectMs: number
    totalMs: number
    perFileMs: { p50: number; p95: number; max: number }
    filesPerSec: number
  }
  items: Decision[]
  perFile: FileTiming[]
}

export interface FileChange {
  file: string
  original: string
  rewritten: string
  edits: EditRecord[]
  skipped: SkipRecord[]
  hadBom: boolean
  crlf: boolean
  notes: string[]
}

export interface EditRecord {
  start: number
  end: number
  kind: string
  key: string
  value: string
  text: string
}

export interface SkipRecord {
  value: string
  reason: string
}

export interface RewriteOptions {
  root: string
  namespace?: string
  keysFile?: string
  threshold?: number
  aliases?: {
    useT?: string
    i18n?: string
    trans?: string
  }
  /** Compute the rewrite but leave sources untouched (the CLI's --dry-run). */
  dryRun?: boolean
  /**
   * Override file writing independently of `dryRun`. The extension needs this:
   * it applies edits through `WorkspaceEdit` (so undo works) but still wants the
   * key registry persisted. Defaults to `!dryRun`.
   */
  writeFiles?: boolean
  /** Persist the key registry. Defaults to `!dryRun`. */
  saveKeys?: boolean
}

export interface RewriteResult {
  files: FileChange[]
  applied: number
  skipped: number
  skipReasons: Record<string, number>
  postParseFailures: { file: string; error: string }[]
  keysFrozen: number
  keysLive: number
  ms: number
}

export interface CoverageReport {
  root: string
  files: number
  filesWithCandidates: number
  candidates: number
  extracted: number
  hardcoded: number
  coverage: number
  deadKeys: number
  totalKeys: number
  byFile: { file: string; total: number; extracted: number; hardcoded: number; coverage: number }[]
  byDir: { dir: string; total: number; extracted: number; hardcoded: number; coverage: number }[]
}
