/**
 * Code lens: the "there are 12 strings in this file" nudge.
 *
 * Runs the real classifier on the in-memory document (not the cached scan), so it stays
 * correct while you type and costs a few milliseconds on a normal file.
 */
import * as vscode from 'vscode'
import { scanDocument } from './scan-service.js'

const SUPPORTED = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue'])

export class ExtractCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event

  constructor(private readonly threshold: () => number) {}

  refresh(): void {
    this.emitter.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!SUPPORTED.has(document.languageId)) return []
    let decisions
    try {
      decisions = scanDocument(document, this.threshold())
    } catch {
      return []
    }
    const accepted = decisions.filter((d) => d.translatable)
    if (!accepted.length) return []

    const range = new vscode.Range(0, 0, 0, 0)
    return [
      new vscode.CodeLens(range, {
        title: `$(wand) Extract ${accepted.length} hard-coded string${accepted.length === 1 ? '' : 's'}`,
        command: 'i18nCodemod.extractFile',
      }),
      new vscode.CodeLens(range, {
        title: 'preview',
        command: 'i18nCodemod.previewFile',
      }),
    ]
  }
}
