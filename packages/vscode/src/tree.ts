/**
 * Candidate tree.
 *
 * Deliberately file-first rather than string-first: the unit of trust in this tool is
 * a file (you review a diff per file), and a flat list of 2,600 strings is noise.
 */
import * as vscode from 'vscode'
import path from 'node:path'
import { coverageFromScan, type Decision } from '@i18n-codemod/core'
import type { WorkspaceScan } from './scan-service.js'

export type TreeNode = SummaryNode | FileNode | CandidateNode

export interface SummaryNode {
  type: 'summary'
  accepted: number
  pool: number
  files: number
  coverage: number
}

export interface FileNode {
  type: 'file'
  file: string
  accepted: number
  pool: number
}

export interface CandidateNode {
  type: 'candidate'
  decision: Decision
}

export class CandidateTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  private scan: WorkspaceScan | null = null
  private byFile = new Map<string, CandidateNode[]>()
  private summary: SummaryNode | null = null

  setScan(scan: WorkspaceScan | null): void {
    this.scan = scan
    this.byFile.clear()
    this.summary = null
    if (scan) {
      for (const d of scan.result.items) {
        if (!d.translatable) continue
        const list = this.byFile.get(d.candidate.file) ?? []
        list.push({ type: 'candidate', decision: d })
        this.byFile.set(d.candidate.file, list)
      }
      for (const list of this.byFile.values()) {
        list.sort((a, b) => a.decision.candidate.start - b.decision.candidate.start)
      }
      const report = coverageFromScan(scan.result, { threshold: scan.threshold })
      this.summary = {
        type: 'summary',
        accepted: scan.result.accepted,
        pool: scan.result.pool,
        files: scan.result.files,
        coverage: report.coverage,
      }
    }
    this.emitter.fire(undefined)
  }

  getSummary(): SummaryNode | null {
    return this.summary
  }

  get files(): string[] {
    return [...this.byFile.keys()].sort()
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.scan) return []
    if (!element) {
      const files = [...this.byFile.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map<FileNode>(([file, list]) => ({
          type: 'file',
          file,
          accepted: list.length,
          pool: this.scan!.result.perFile.find((f) => f.file === file)?.pool ?? list.length,
        }))
      return this.summary ? [this.summary, ...files] : files
    }
    if (element.type === 'file') return this.byFile.get(element.file) ?? []
    return []
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.type === 'summary') {
      const item = new vscode.TreeItem('Coverage', vscode.TreeItemCollapsibleState.None)
      item.description = `${(element.coverage * 100).toFixed(1)}% · ${element.accepted} of ${element.pool} strings`
      item.tooltip = [
        `${element.files} files scanned`,
        `${element.pool} candidate strings, ${element.accepted} above threshold`,
        'Click to open the full report',
      ].join('\n')
      item.iconPath = new vscode.ThemeIcon('graph')
      item.command = { command: 'i18nCodemod.showReport', title: 'Show coverage report' }
      return item
    }

    if (element.type === 'file') {
      const item = new vscode.TreeItem(path.basename(element.file), vscode.TreeItemCollapsibleState.Expanded)
      const dir = path.dirname(element.file)
      item.description = `${element.accepted} string${element.accepted === 1 ? '' : 's'}`
      item.tooltip = element.file
      item.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(this.scan?.root ?? ''), element.file)
      item.contextValue = 'i18nFile'
      item.iconPath = new vscode.ThemeIcon(dir === '.' ? 'file' : 'folder')
      return item
    }

    const c = element.decision.candidate
    const label = c.value.replace(/\s+/g, ' ').trim().slice(0, 72) || c.raw.slice(0, 72)
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None)
    item.description = `${c.kind} · ${element.decision.score.toFixed(2)}`
    item.tooltip = new vscode.MarkdownString(
      [
        `**${c.kind}** at \`${c.file}:${c.line}\``,
        '',
        '```',
        c.value,
        '```',
        '',
        `score **${element.decision.score.toFixed(2)}**`,
        ...element.decision.reasons.map((r) => `- ${r}`),
      ].join('\n'),
    )
    item.iconPath = new vscode.ThemeIcon(element.decision.score >= 0.7 ? 'check' : 'warning')
    item.command = {
      command: 'i18nCodemod.revealCandidate',
      title: 'Reveal',
      arguments: [this.scan?.root ?? '', c.file, c.line, c.column],
    }
    return item
  }
}
