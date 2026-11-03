/**
 * Turning core's file changes into a `WorkspaceEdit`.
 *
 * Using WorkspaceEdit rather than fs.writeFile is not cosmetic: it puts the rewrite on
 * VS Code's undo stack, so a bad extraction is one Ctrl+Z away instead of a git checkout.
 * That single property removes most of the fear the tool otherwise inspires.
 */
import * as vscode from 'vscode'
import path from 'node:path'
import type { FileChange } from '@i18n-codemod/core'

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/** Range covering the whole document, derived from the pre-rewrite text. */
function fullRange(text: string): vscode.Range {
  const starts = lineStarts(text)
  const last = starts.length - 1
  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(last, text.length - starts[last]!))
}

export interface ApplyPlan {
  edit: vscode.WorkspaceEdit
  uris: vscode.Uri[]
  files: number
  edits: number
}

export function buildWorkspaceEdit(changes: FileChange[], root: string): ApplyPlan {
  const edit = new vscode.WorkspaceEdit()
  const uris: vscode.Uri[] = []
  let count = 0

  for (const change of changes) {
    const uri = vscode.Uri.file(path.join(root, change.file))
    uris.push(uri)
    // Whole-document replacement rather than per-string ranges. The rewrite also
    // injects imports (`useT`, `Trans`, `i18n`) whose offsets are not part of the
    // string edit list; applying only the string edits silently produces code that
    // calls `t()` without importing it — valid syntax, broken at runtime. Replacing
    // the whole document keeps the editor undoable and cannot drift from the text the
    // core actually produced (including line-ending normalisation).
    edit.replace(uri, fullRange(change.original), change.rewritten)
    count += change.edits.length
  }

  return { edit, uris, files: uris.length, edits: count }
}

/** Refuse to touch files with unsaved changes: offsets were computed from disk. */
export async function findDirty(uris: vscode.Uri[]): Promise<vscode.TextDocument[]> {
  const dirty: vscode.TextDocument[] = []
  for (const uri of uris) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (doc?.isDirty) dirty.push(doc)
  }
  return dirty
}

export async function previewDiff(
  root: string,
  change: FileChange,
  title: string,
): Promise<void> {
  const ext = path.extname(change.file).replace('.', '')
  const language =
    ext === 'vue' ? 'vue' : ext === 'tsx' ? 'typescriptreact' : ext === 'jsx' ? 'javascriptreact' : ext === 'ts' ? 'typescript' : 'javascript'
  const left = vscode.Uri.file(path.join(root, change.file))
  const right = await vscode.workspace.openTextDocument({ content: change.rewritten, language })
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right.uri,
    `${path.basename(change.file)} — ${title} (left: current, right: extracted)`,
  )
}
