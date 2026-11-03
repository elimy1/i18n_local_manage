/**
 * Workspace scanning for the extension.
 *
 * The core scanner is synchronous, which is the right shape for a CLI but the wrong
 * shape for an editor: a 3k-file scan would block the extension host for a second and
 * the progress notification would never paint. So we drive the per-file loop here and
 * yield between chunks. Cancellation is honoured between files, which is granular
 * enough that even a mid-scan cancel never leaves a half-rewritten file behind —
 * scanning is read-only by definition.
 */
import * as vscode from 'vscode'
import {
  collectFiles,
  percentile,
  readSource,
  scanSource,
  type Decision,
  type FileTiming,
  type ScanResult,
} from '@i18n-codemod/core'

export interface WorkspaceScan {
  root: string
  result: ScanResult
  at: number
  threshold: number
  durationMs: number
}

const CHUNK = 40

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class ScanService {
  private readonly cache = new Map<string, WorkspaceScan>()

  constructor(private readonly log: vscode.OutputChannel) {}

  get(folder: vscode.WorkspaceFolder, threshold: number): WorkspaceScan | undefined {
    return this.cache.get(this.key(folder, threshold))
  }

  clear(): void {
    this.cache.clear()
  }

  private key(folder: vscode.WorkspaceFolder, threshold: number): string {
    return `${folder.uri.fsPath}::${threshold}`
  }

  async scan(
    folder: vscode.WorkspaceFolder,
    threshold: number,
    token?: vscode.CancellationToken,
    onProgress?: (done: number, total: number) => void,
  ): Promise<WorkspaceScan | null> {
    const root = folder.uri.fsPath
    const started = Date.now()
    const maxFiles = vscode.workspace.getConfiguration('i18nCodemod').get<number>('maxFiles', 0)

    const walkStart = Date.now()
    const files = collectFiles(root, { maxFiles: maxFiles > 0 ? maxFiles : undefined })
    const walkMs = Date.now() - walkStart
    this.log.appendLine(`scan ${root}: ${files.length} files, walk ${walkMs}ms`)

    const items: Decision[] = []
    const perFile: FileTiming[] = []
    const parseErrors: { file: string; error: string }[] = []
    let pool = 0
    let accepted = 0
    let done = 0

    for (const file of files) {
      if (token?.isCancellationRequested) {
        this.log.appendLine('scan cancelled')
        return null
      }
      const t0 = performance.now()
      try {
        const source = readSource(file.abs)
        const scanned = scanSource(file.rel, source, threshold)
        const ms = performance.now() - t0
        pool += scanned.items.length
        accepted += scanned.decisions.filter((d) => d.translatable).length
        items.push(...scanned.decisions)
        perFile.push({
          file: file.rel,
          bytes: file.size,
          ms: Math.round(ms * 100) / 100,
          pool: scanned.items.length,
          accepted: scanned.decisions.filter((d) => d.translatable).length,
        })
        if (!scanned.parseOk && scanned.parseError) {
          parseErrors.push({ file: file.rel, error: scanned.parseError })
        }
      } catch (err) {
        parseErrors.push({ file: file.rel, error: err instanceof Error ? err.message : String(err) })
      }

      done++
      if (done % CHUNK === 0) {
        onProgress?.(done, files.length)
        await yieldToHost()
      }
    }
    onProgress?.(done, files.length)

    const totalMs = Date.now() - started
    const times = perFile.map((f) => f.ms)
    const result: ScanResult = {
      root,
      files: files.length,
      pool,
      accepted,
      parseErrors,
      timings: {
        walkMs,
        parseMs: Math.round(times.reduce((a, b) => a + b, 0)),
        detectMs: 0,
        totalMs,
        perFileMs: {
          p50: percentile(times, 50),
          p95: percentile(times, 95),
          max: times.length ? Math.max(...times) : 0,
        },
        filesPerSec: totalMs > 0 ? Math.round((files.length / totalMs) * 1000) : 0,
      },
      items,
      perFile,
    }

    const scan: WorkspaceScan = { root, result, at: Date.now(), threshold, durationMs: totalMs }
    this.cache.set(this.key(folder, threshold), scan)
    this.log.appendLine(
      `scan done: ${result.files} files, ${result.accepted}/${result.pool} accepted, ${totalMs}ms, ${parseErrors.length} parse errors`,
    )
    return scan
  }
}

/** Scan a single in-memory document (active file, code lens). */
export function scanDocument(document: vscode.TextDocument, threshold: number): Decision[] {
  if (document.uri.scheme !== 'file') return []
  const rel = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/')
  const scanned = scanSource(rel, document.getText(), threshold)
  return scanned.decisions
}
