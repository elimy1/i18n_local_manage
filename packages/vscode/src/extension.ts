import * as vscode from 'vscode'
import path from 'node:path'
import {
  KeyRegistry,
  applyFile,
  coverageFromScan,
  exportCatalogs,
  findDeadKeys,
  flattenCatalog,
  readCatalog,
  rewriteProject,
} from '@i18n-codemod/core'
import { catalogPath, resolveAdapter } from '@i18n-codemod/adapters'
import { ScanService, scanDocument, type WorkspaceScan } from './scan-service.js'
import { CandidateTree } from './tree.js'
import { buildWorkspaceEdit, findDirty, previewDiff } from './apply.js'
import { ExtractCodeLens } from './codelens.js'
import { renderReport } from './report.js'

interface Config {
  threshold: number
  namespace: string
  keysFile: string
  catalogDir: string
  adapter: string
  aliases: { useT: string; i18n: string; trans: string }
  showStatusBar: boolean
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('i18nCodemod')
  return {
    threshold: c.get<number>('threshold', 0.55),
    namespace: c.get<string>('namespace', 'app'),
    keysFile: c.get<string>('keysFile', 'out/keys.json'),
    catalogDir: c.get<string>('catalogDir', ''),
    adapter: c.get<string>('adapter', 'auto'),
    // Empty strings mean "take it from the adapter" ? see effectiveAliases().
    aliases: {
      useT: c.get<string>('aliasUseT', ''),
      i18n: c.get<string>('aliasI18n', ''),
      trans: c.get<string>('aliasTrans', ''),
    },
    showStatusBar: c.get<boolean>('showStatusBar', true),
  }
}

/** Adapter defaults, with explicit alias settings winning when the user set them. */
function effectiveAliases(cfg: Config, root: string): { useT: string; i18n: string; trans: string } {
  const adapter = resolveAdapter(root, cfg.adapter)
  return {
    useT: cfg.aliases.useT || adapter.aliases.useT,
    i18n: cfg.aliases.i18n || adapter.aliases.i18n,
    trans: cfg.aliases.trans || adapter.aliases.trans,
  }
}

function folderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) return undefined
  if (uri) return vscode.workspace.getWorkspaceFolder(uri) ?? folders[0]
  const active = vscode.window.activeTextEditor?.document.uri
  return (active && vscode.workspace.getWorkspaceFolder(active)) ?? folders[0]
}

function requireFolder(folder: vscode.WorkspaceFolder | undefined): vscode.WorkspaceFolder {
  if (!folder) throw new Error('Open a folder first — i18n Codemod scans a workspace, not a buffer.')
  return folder
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('i18n Codemod')
  const service = new ScanService(log)
  const tree = new CandidateTree()
  const view = vscode.window.createTreeView('i18nCodemod.candidates', { treeDataProvider: tree, showCollapseAll: true })
  context.subscriptions.push(view)

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.command = 'i18nCodemod.scan'
  status.text = '$(globe) i18n —'
  status.tooltip = 'i18n Codemod: click to scan for hard-coded strings'
  if (readConfig().showStatusBar) status.show()

  const lens = new ExtractCodeLens(() => readConfig().threshold)
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens))
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) lens.refresh()
    }),
    vscode.window.onDidChangeActiveTextEditor(() => lens.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('i18nCodemod')) return
      service.clear()
      tree.setScan(null)
      lens.refresh()
      if (readConfig().showStatusBar) status.show()
      else status.hide()
    }),
  )

  const ensureScan = async (
    folder: vscode.WorkspaceFolder,
    cfg: Config,
    token?: vscode.CancellationToken,
    force = false,
  ): Promise<WorkspaceScan | null> => {
    if (!force) {
      const cached = service.get(folder, cfg.threshold)
      if (cached) return cached
    }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'i18n Codemod: scanning', cancellable: true },
      async (progress, cancelToken) => {
        const scan = await service.scan(folder, cfg.threshold, token ?? cancelToken, (done, total) => {
          progress.report({
            message: `${done}/${total} files`,
            increment: total ? (done / total) * 100 - (done - 1 > 0 ? 0 : 0) : 0,
          })
        })
        if (!scan) {
          vscode.window.showInformationMessage('i18n Codemod: scan cancelled.')
          return null
        }
        tree.setScan(scan)
        const report = coverageFromScan(scan.result, { threshold: scan.threshold })
        status.text = `$(globe) i18n ${(report.coverage * 100).toFixed(1)}%`
        status.tooltip = `${scan.result.accepted} hard-coded strings in ${scan.result.files} files · ${report.coverage ? (report.coverage * 100).toFixed(1) : '0.0'}% translated`
        view.description = `${scan.result.accepted} strings`
        return scan
      },
    )
  }

  const register = (id: string, fn: (...args: any[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.appendLine(`[${id}] ${message}`)
          void vscode.window.showErrorMessage(`i18n Codemod: ${message}`, 'Show log').then((pick) => {
            if (pick) log.show()
          })
        }
      }),
    )
  }

  register('i18nCodemod.scan', async () => {
    const cfg = readConfig()
    const folder = requireFolder(folderFor())
    const scan = await ensureScan(folder, cfg, undefined, true)
    if (!scan) return
    const report = coverageFromScan(scan.result, { threshold: scan.threshold })
    void vscode.window.showInformationMessage(
      `i18n Codemod: ${scan.result.accepted} hard-coded strings in ${scan.result.files} files · ${(report.coverage * 100).toFixed(1)}% covered · ${scan.durationMs}ms`,
    )
  })

  register('i18nCodemod.applyAll', async () => {
    const cfg = readConfig()
    const folder = requireFolder(folderFor())
    if (!vscode.workspace.isTrusted) {
      throw new Error('Rewriting source files requires a trusted workspace.')
    }
    const scan = await ensureScan(folder, cfg)
    if (!scan) return
    const accepted = scan.result.items.filter((d) => d.translatable)
    if (!accepted.length) {
      void vscode.window.showInformationMessage('i18n Codemod: nothing to extract at the current threshold.')
      return
    }
    const fileCount = new Set(accepted.map((d) => d.candidate.file)).size

    const choice = await vscode.window.showWarningMessage(
      `Rewrite ${fileCount} file${fileCount === 1 ? '' : 's'} and extract ${accepted.length} string${accepted.length === 1 ? '' : 's'}?`,
      {
        modal: true,
        detail:
          'Edits go through the editor undo stack, so Ctrl+Z reverts them. The key registry is written separately and keeps keys stable across runs.',
      },
      'Rewrite',
    )
    if (choice !== 'Rewrite') return

    const keysFile = path.join(folder.uri.fsPath, cfg.keysFile)
    const aliases = effectiveAliases(cfg, folder.uri.fsPath)
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'i18n Codemod: rewriting', cancellable: false },
      async () =>
        rewriteProject(scan.result.items, {
          root: folder.uri.fsPath,
          threshold: cfg.threshold,
          keysFile,
          namespace: cfg.namespace,
          aliases,
          // Files are applied through WorkspaceEdit below; the registry is saved here.
          dryRun: true,
          writeFiles: false,
          saveKeys: true,
        }),
    )

    const plan = buildWorkspaceEdit(result.files, folder.uri.fsPath)
    const dirty = await findDirty(plan.uris)
    if (dirty.length) {
      throw new Error(`Save ${dirty.length} modified file(s) first: ${dirty.map((d) => path.basename(d.fileName)).join(', ')}`)
    }
    if (!plan.edits) {
      void vscode.window.showInformationMessage('i18n Codemod: no safe edits to apply (everything was gated).')
      return
    }

    const ok = await vscode.workspace.applyEdit(plan.edit, { isRefactoring: true })
    if (!ok) throw new Error('VS Code rejected the workspace edit.')

    for (const uri of plan.uris) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
      if (doc?.isDirty) await doc.save()
    }

    let catalogLine = ''
    if (cfg.catalogDir) {
      const out = exportCatalogs(result.files, path.join(folder.uri.fsPath, cfg.catalogDir))
      catalogLine = ` · catalog ${out.keys} keys`
    }

    log.appendLine(
      `apply: ${plan.files} files, ${plan.edits} edits, ${result.skipped} skipped, keys ${result.keysLive} live / ${result.keysFrozen} frozen, ${result.ms}ms`,
    )
    const skipNote = result.skipped ? ` · ${result.skipped} skipped (see log)` : ''
    for (const [reason, n] of Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1])) {
      log.appendLine(`  skipped ${reason}: ${n}`)
    }
    void vscode.window
      .showInformationMessage(
        `i18n Codemod: extracted ${plan.edits} strings in ${plan.files} files${skipNote}${catalogLine}`,
        'Undo',
        'Show log',
      )
      .then((pick) => {
        if (pick === 'Undo') void vscode.commands.executeCommand('undo')
        if (pick === 'Show log') log.show()
      })

    const rescan = await ensureScan(folder, cfg, undefined, true)
    if (rescan) lens.refresh()
  })

  register('i18nCodemod.extractFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw new Error('Open a file first.')
    const doc = editor.document
    const folder = requireFolder(folderFor(doc.uri))
    const cfg = readConfig()
    if (doc.isDirty) throw new Error('Save the file before extracting — offsets come from disk.')
    if (!vscode.workspace.isTrusted) throw new Error('Rewriting requires a trusted workspace.')

    const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/')
    const candidates = scanDocument(doc, cfg.threshold)
      .filter((d) => d.translatable)
      .map((d) => d.candidate)
    if (!candidates.length) {
      void vscode.window.showInformationMessage('i18n Codemod: no hard-coded strings found in this file.')
      return
    }

    const registry = new KeyRegistry(path.join(folder.uri.fsPath, cfg.keysFile), cfg.namespace)
    const aliases = effectiveAliases(cfg, folder.uri.fsPath)
    const { change, report } = applyFile(rel, candidates, doc.getText(), registry, aliases)
    if (!change) {
      const reasons = report.skipped.map((s) => s.reason).join(', ')
      throw new Error(`Nothing could be rewritten safely: ${reasons || 'all edits were gated'}`)
    }

    const edit = new vscode.WorkspaceEdit()
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    edit.replace(doc.uri, full, change.rewritten)
    const ok = await vscode.workspace.applyEdit(edit, { isRefactoring: true })
    if (!ok) throw new Error('VS Code rejected the edit.')
    await doc.save()

    const used = new Set(report.records.map((r) => r.key).filter(Boolean))
    registry.prune(used)
    registry.save()

    void vscode.window.showInformationMessage(
      `i18n Codemod: extracted ${report.applied} string${report.applied === 1 ? '' : 's'} in ${path.basename(doc.fileName)}`,
      'Undo',
    ).then((pick) => {
      if (pick === 'Undo') void vscode.commands.executeCommand('undo')
    })
  })

  register('i18nCodemod.previewFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw new Error('Open a file first.')
    const doc = editor.document
    const folder = requireFolder(folderFor(doc.uri))
    const cfg = readConfig()
    const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/')
    const candidates = scanDocument(doc, cfg.threshold)
      .filter((d) => d.translatable)
      .map((d) => d.candidate)
    if (!candidates.length) {
      void vscode.window.showInformationMessage('i18n Codemod: no hard-coded strings in this file.')
      return
    }
    const registry = new KeyRegistry(path.join(context.globalStorageUri.fsPath, 'preview-keys.json'), cfg.namespace)
    const { change } = applyFile(rel, candidates, doc.getText(), registry, effectiveAliases(cfg, folder.uri.fsPath))
    if (!change) throw new Error('Nothing could be rewritten safely in this file.')
    await previewDiff(folder.uri.fsPath, change, 'preview')
  })

  register('i18nCodemod.showReport', async () => {
    const cfg = readConfig()
    const folder = requireFolder(folderFor())
    const scan = await ensureScan(folder, cfg)
    if (!scan) return

    let catalog: { totalKeys: number; deadKeys: string[] } | null = null
    let catalogKeys: string[] | undefined
    if (cfg.catalogDir) {
      const file = path.join(folder.uri.fsPath, cfg.catalogDir, 'zh-CN.json')
      try {
        const keys = Object.keys(flattenCatalog(readCatalog({ abs: file, format: 'json', locale: 'zh-CN' })))
        catalogKeys = keys
        catalog = { totalKeys: keys.length, deadKeys: findDeadKeys(scan.result, keys) }
      } catch {
        catalogKeys = undefined
      }
    }

    const report = coverageFromScan(scan.result, { threshold: scan.threshold, catalogKeys })
    const markdown = renderReport(scan.result, report, catalog)
    const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' })
    await vscode.window.showTextDocument(doc, { preview: false })
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri)
  })

  register('i18nCodemod.clearCache', async () => {
    service.clear()
    tree.setScan(null)
    status.text = '$(globe) i18n —'
    view.description = ''
    void vscode.window.showInformationMessage('i18n Codemod: scan cache cleared.')
  })

  register('i18nCodemod.revealCandidate', async (root: string, file: string, line: number, column: number) => {
    const uri = vscode.Uri.file(path.join(root, file))
    const doc = await vscode.workspace.openTextDocument(uri)
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1))
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
      preview: true,
    })
  })

  register('i18nCodemod.explainString', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw new Error('Open a file first.')
    const cfg = readConfig()
    const selected = editor.document.getText(editor.selection)
    const decisions = scanDocument(editor.document, cfg.threshold)
    const hits = selected
      ? decisions.filter((d) => d.candidate.value.includes(selected))
      : decisions.filter((d) => {
          const line = d.candidate.line - 1
          return line >= editor.selection.start.line && line <= editor.selection.end.line
        })
    if (!hits.length) {
      void vscode.window.showInformationMessage('i18n Codemod: no candidate matches the selection.')
      return
    }
    const items = hits.map((d) => ({
      label: d.translatable ? '$(check) extract' : '$(circle-slash) skip',
      description: `${d.score.toFixed(2)} · ${d.candidate.kind}`,
      detail: `${d.candidate.value} — ${d.reasons.join(', ')}`,
      decision: d,
    }))
    const pick = await vscode.window.showQuickPick(items, { title: 'Why was this (not) extracted?' })
    if (pick) {
      const pos = new vscode.Position(pick.decision.candidate.line - 1, Math.max(0, pick.decision.candidate.column - 1))
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }
  })

  context.subscriptions.push(log, status)
  log.appendLine('i18n Codemod activated')
}

export function deactivate(): void {
  /* nothing to dispose: everything is registered on the extension context */
}
