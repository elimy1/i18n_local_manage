/**
 * A minimal stand-in for the `vscode` module, so the extension can be exercised under
 * plain Node. This is not a general-purpose mock: it implements exactly the surface
 * `src/*.ts` touches, and `applyEdit` really does write to disk so the assertions in
 * integration.mjs are about real files, not about mock call counts.
 *
 * Wired up through a module resolve hook (see integration.mjs) rather than by dropping a
 * stub into node_modules — pnpm prunes unknown packages there, and a stub that silently
 * disappears turns a green test into a broken build.
 */
import fs from 'node:fs'
import path from 'node:path'

export const state = {
  folders: [],
  config: {},
  commands: {},
  log: [],
  messages: [],
  errors: [],
  warningAnswer: undefined,
  activeEditor: null,
  lastDocument: null,
  applyEditCount: 0,
  treeViews: [],
  statusBar: [],
  codeLensProviders: [],
}

export class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
}

export class Range {
  constructor(start, end) {
    this.start = start
    this.end = end
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character
  }
}

export class Selection extends Range {
  constructor(anchor, active) {
    super(anchor, active)
    this.anchor = anchor
    this.active = active
  }
}

export class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath
    this.scheme = 'file'
    this.path = fsPath.replace(/\\/g, '/')
  }
  toString() {
    return `file:///${this.fsPath.replace(/\\/g, '/')}`
  }
  static file(p) {
    return new Uri(path.resolve(p))
  }
  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts))
  }
  static parse(value) {
    return new Uri(value.replace(/^file:\/\/\/?/, ''))
  }
}

export class EventEmitter {
  #listeners = new Set()
  constructor() {
    this.event = (listener) => {
      this.#listeners.add(listener)
      return { dispose: () => this.#listeners.delete(listener) }
    }
  }
  fire(value) {
    for (const l of this.#listeners) l(value)
  }
  dispose() {
    this.#listeners.clear()
  }
}

export class ThemeIcon {
  constructor(id) {
    this.id = id
  }
}

export class MarkdownString {
  constructor(value = '') {
    this.value = value
  }
  appendMarkdown(v) {
    this.value += v
    return this
  }
}

export class TreeItem {
  constructor(label, collapsibleState = 0) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 }
export const StatusBarAlignment = { Left: 1, Right: 2 }
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 }
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 }

export class TextEdit {
  constructor(range, newText) {
    this.range = range
    this.newText = newText
  }
  static replace(range, newText) {
    return new TextEdit(range, newText)
  }
  static insert(position, newText) {
    return new TextEdit(new Range(position, position), newText)
  }
  static delete(range) {
    return new TextEdit(range, '')
  }
}

export class CodeLens {
  constructor(range, command) {
    this.range = range
    this.command = command
  }
}

export class WorkspaceEdit {
  #entries = new Map()
  set(uri, edits) {
    this.#entries.set(uri.toString(), { uri, edits })
  }
  replace(uri, range, newText) {
    this.set(uri, [TextEdit.replace(range, newText)])
  }
  get size() {
    return this.#entries.size
  }
  entries() {
    return [...this.#entries.values()].map((e) => [e.uri, e.edits])
  }
}

function lineStartsOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function offsetAt(starts, pos) {
  const start = starts[Math.min(pos.line, starts.length - 1)]
  return start + pos.character
}

function makeDocument(uri, text) {
  const starts = lineStartsOf(text)
  return {
    uri,
    fileName: uri.fsPath,
    languageId: guessLanguage(uri.fsPath),
    isDirty: false,
    version: 1,
    getText: () => text,
    positionAt: (offset) => {
      let line = 0
      while (line + 1 < starts.length && starts[line + 1] <= offset) line++
      return new Position(line, offset - starts[line])
    },
    lineAt: (line) => {
      const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length
      return { text: text.slice(starts[line], end), lineNumber: line }
    },
    save: async () => true,
  }
}

function guessLanguage(file) {
  if (file.endsWith('.vue')) return 'vue'
  if (file.endsWith('.tsx')) return 'typescriptreact'
  if (file.endsWith('.jsx')) return 'javascriptreact'
  if (file.endsWith('.ts')) return 'typescript'
  return 'javascript'
}

export const workspace = {
  get workspaceFolders() {
    return state.folders
  },
  get textDocuments() {
    return []
  },
  get isTrusted() {
    return true
  },
  getWorkspaceFolder(uri) {
    return state.folders.find((f) => uri.fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase()))
  },
  asRelativePath(uri, includeFolder = false) {
    const fsPath = typeof uri === 'string' ? uri : uri.fsPath
    const root = state.folders[0]?.uri.fsPath ?? process.cwd()
    const rel = path.relative(root, fsPath).replace(/\\/g, '/')
    return includeFolder ? rel : rel
  },
  getConfiguration(section) {
    return {
      get(key, fallback) {
        const full = section ? `${section}.${key}` : key
        return state.config[full] ?? fallback
      },
      has(key) {
        return `${section}.${key}` in state.config
      },
    }
  },
  onDidChangeConfiguration: () => ({ dispose() {} }),
  onDidChangeTextDocument: () => ({ dispose() {} }),
  openTextDocument: async (arg) => {
    if (arg instanceof Uri) {
      const text = fs.readFileSync(arg.fsPath, 'utf8')
      return makeDocument(arg, text)
    }
    return makeDocument(Uri.file(path.join(state.folders[0]?.uri.fsPath ?? '.', 'untitled.md')), arg.content ?? '')
  },
  /**
   * Really applies the edit: the point of the test is that offsets computed by the core
   * land on the right characters in the real file.
   */
  applyEdit: async (edit) => {
    state.applyEditCount++
    for (const [uri, edits] of edit.entries()) {
      const text = fs.readFileSync(uri.fsPath, 'utf8')
      const starts = lineStartsOf(text)
      const ranges = edits
        .map((e) => ({ start: offsetAt(starts, e.range.start), end: offsetAt(starts, e.range.end), text: e.newText }))
        .sort((a, b) => b.start - a.start)
      let next = text
      for (const r of ranges) next = next.slice(0, r.start) + r.text + next.slice(r.end)
      fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true })
      fs.writeFileSync(uri.fsPath, next)
    }
    return true
  },
}

export const window = {
  get activeTextEditor() {
    return state.activeEditor
  },
  createOutputChannel: (name) => ({
    name,
    appendLine: (m) => state.log.push(m),
    append: (m) => state.log.push(m),
    show: () => {},
    dispose: () => {},
  }),
  createTreeView: (id, opts) => {
    const view = { id, treeDataProvider: opts.treeDataProvider, description: '', dispose: () => {} }
    state.treeViews.push(view)
    return view
  },
  createStatusBarItem: (alignment, priority) => {
    const item = { alignment, priority, text: '', tooltip: '', command: '', visible: false, show() { this.visible = true }, hide() { this.visible = false }, dispose: () => {} }
    state.statusBar.push(item)
    return item
  },
  withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
  showInformationMessage: async (message) => {
    state.messages.push(message)
    return undefined
  },
  showWarningMessage: async (message) => {
    state.messages.push(message)
    return state.warningAnswer
  },
  showErrorMessage: async (message) => {
    state.errors.push(message)
    return undefined
  },
  showQuickPick: async () => undefined,
  showTextDocument: async (doc) => {
    state.lastDocument = doc
    return { document: doc, selection: null, revealRange: () => {} }
  },
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
}

export const languages = {
  registerCodeLensProvider: (_selector, provider) => {
    state.codeLensProviders.push(provider)
    return { dispose: () => {} }
  },
}

export const commands = {
  registerCommand: (id, fn) => {
    state.commands[id] = fn
    return { dispose: () => delete state.commands[id] }
  },
  executeCommand: async (id, ...args) => {
    const fn = state.commands[id]
    if (!fn) throw new Error(`command not found: ${id}`)
    return fn(...args)
  },
}
