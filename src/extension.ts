import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { QuasarIndex } from './core/quasarIndex'
import type { ColorPropsData } from './core/types'
import { QuasarCompletionProvider, QuasarHoverProvider, themeKind, type IndexHost } from './vscode/providers'
import { findInstalledPackage, hasQuasarDependency } from './vscode/nodeModules'
import { ColorDecorations } from './vscode/decorations'
import { ColorDiagnostics } from './vscode/diagnostics'
import { QuasarDefinitionProvider } from './vscode/definitions'
import { QuasarCodeActionProvider } from './vscode/codeActions'
import { CustomColorScanner } from './vscode/watchers'
import { IconData } from './vscode/iconData'
import { QuasarStatusBar } from './vscode/statusBar'
import { readQuasarConfig } from './vscode/quasarConfig'

const SELECTOR: vscode.DocumentSelector = { language: 'vue', scheme: 'file' }

let output: vscode.OutputChannel

/**
 * Dormancy contract: in a workspace without quasar, activate() does at most
 * three tiny fs reads (root package.json + two monorepo marker stats) and
 * returns. No output channel, no status bar, no providers, no watchers, no
 * workspace search. The one-shot sub-package search runs only when monorepo
 * markers exist or there is no root package.json at all.
 */
export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!folder) return

  if (hasQuasarDependency(folder)) {
    activateFeatures(context, folder, folder)
    return
  }
  if (!mayHoldSubPackages(folder)) return // ordinary non-quasar project: fully dormant

  // monorepo: the quasar app may live in a sub-package
  void findQuasarPackageRoot(folder).then((root) => {
    if (root) activateFeatures(context, root, folder)
  })
}

/** cheap monorepo markers, so ordinary non-quasar projects trigger no search */
function mayHoldSubPackages(folder: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
    if (pkg.workspaces) return true
  } catch {
    return true // no root package.json: a quasar app may sit in a subfolder
  }
  return ['pnpm-workspace.yaml', 'lerna.json', 'nx.json']
    .some((f) => fs.existsSync(path.join(folder, f)))
}

/** shallowest sub-package whose package.json depends on quasar */
async function findQuasarPackageRoot(folder: string): Promise<string | undefined> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/package.json'), '**/node_modules/**', 200)
  const dirs = uris.map((u) => path.dirname(u.fsPath)).filter((d) => d !== folder)
  dirs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
  return dirs.find(hasQuasarDependency)
}

/** root: the quasar app directory; folder: the workspace folder containing it */
function activateFeatures(context: vscode.ExtensionContext, root: string, folder: string): void {
  const started = Date.now()
  output = vscode.window.createOutputChannel('Quasar IntelliSense')
  context.subscriptions.push(output)
  const appRootRel = path.relative(folder, root)
  if (appRootRel) output.appendLine(`Quasar app found in sub-package: ${appRootRel}/`)

  // monorepos hoist node_modules: resolve installed packages walking up
  const quasarDir = findInstalledPackage('quasar', root, folder)
  const host: IndexHost = { index: new QuasarIndex(buildStaticInputs(quasarDir)) }

  host.index.setActiveTheme(themeKind())

  const completionProvider = new QuasarCompletionProvider(host)
  const decorations = new ColorDecorations(host)
  const diagnostics = new ColorDiagnostics(host)
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, completionProvider, '"', "'", ' ', '='),
    vscode.languages.registerHoverProvider(SELECTOR, new QuasarHoverProvider(host)),
    vscode.languages.registerDefinitionProvider(SELECTOR, new QuasarDefinitionProvider(host, root)),
    vscode.languages.registerCodeActionsProvider(
      SELECTOR, new QuasarCodeActionProvider(host), QuasarCodeActionProvider.metadata),
    vscode.window.onDidChangeActiveColorTheme(() => {
      host.index.setActiveTheme(themeKind())
      host.icons?.clearRenderCache()
      decorations.updateAll()
      diagnostics.refreshAll()
    }),
  )
  decorations.register(context)
  diagnostics.register(context)

  // status bar badge; commands are palette-gated on this context key
  void vscode.commands.executeCommand('setContext', 'quasarIntellisense.active', true)
  const statusBar = new QuasarStatusBar(host, {
    quasarVersion: quasarDir ? readPackageVersion(quasarDir) : undefined,
    appRootRel,
    configFile: readQuasarConfig(root)?.file,
  })
  statusBar.register(context, output)

  output.appendLine(
    `Activated in ${Date.now() - started}ms: ${host.index.classEntries.length} classes, ` +
    `${host.index.colors.size} colors, ${host.index.colorPropNames.size} color props.`,
  )

  // custom colors arrive asynchronously; completions work immediately with defaults
  const scanner = new CustomColorScanner(
    host, root,
    () => {
      decorations.updateAll()
      diagnostics.refreshAll()
      statusBar.refresh()
    },
    (msg) => output.appendLine(msg),
  )
  scanner.register(context)
  void scanner.scan()

  // the 152-file dist/api walk costs ~13ms: run it after activation and swap
  // the (rarely different) runtime table over the bundled one when it lands
  setImmediate(() => {
    try {
      if (!quasarDir) throw new Error('quasar not installed')
      host.index.setColorProps(walkApiForColorProps(path.join(quasarDir, 'dist/api')))
      statusBar.refresh()
    } catch {
      output.appendLine('quasar/dist/api not readable, keeping bundled color-prop table.')
    }
  })

  // icons: detect sets, load name lists, then preload svg bodies for previews;
  // all off the activation path, decorations appear when data lands
  const icons = new IconData(root, folder, (msg) => output.appendLine(msg))
  host.icons = icons
  void icons.initialize().then(async () => {
    // non-CLI flavors enable the css addon by importing it in a source file
    if (icons.addonCssDetected) host.index.setAddonCssImported(true)
    statusBar.refresh()
    await Promise.all(icons.detectedSets.map((set) => icons.ensureSvgs(set)))
    decorations.updateAll()
    diagnostics.refreshAll()
  })
}

function readPackageVersion(pkgDir: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}

export function deactivate(): void {}

function buildStaticInputs(quasarDir: string | undefined): {
  variablesSassText?: string
  variablesSassPath?: string
} {
  const inputs: { variablesSassText?: string; variablesSassPath?: string } = {}
  try {
    if (!quasarDir) throw new Error('quasar not installed')
    const variablesPath = path.join(quasarDir, 'src/css/variables.sass')
    inputs.variablesSassText = fs.readFileSync(variablesPath, 'utf8')
    inputs.variablesSassPath = variablesPath
  } catch {
    output.appendLine('quasar/src/css/variables.sass not readable, using bundled palette snapshot.')
  }
  return inputs
}

const kebab = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()

/** NamedColor-tagged, or an untagged String prop whose desc references the palette
 *  (quasar's own metadata misses QDate.event-color, QEditor.toolbar-toggle-color) */
function isColorPropDef(def: { tsType?: string; type?: unknown; desc?: string }): boolean {
  if (def?.tsType === 'NamedColor') return true
  const type = Array.isArray(def?.type) ? def.type : [def?.type]
  return type.includes('String') && /quasar (color )?palette/i.test(def?.desc ?? '')
}

function walkApiForColorProps(apiDir: string): ColorPropsData {
  const components: Record<string, string[]> = {}
  const propNames = new Set<string>()
  for (const file of fs.readdirSync(apiDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const api = JSON.parse(fs.readFileSync(path.join(apiDir, file), 'utf8'))
      const props = api.props as Record<string, { tsType?: string; type?: unknown; desc?: string }> | undefined
      if (!props) continue
      const colorProps = Object.entries(props)
        .filter(([, def]) => isColorPropDef(def))
        .map(([key]) => kebab(key))
      if (colorProps.length > 0) {
        components[kebab(path.basename(file, '.json'))] = colorProps
        colorProps.forEach((p) => propNames.add(p))
      }
    } catch {
      // single unreadable api file: skip
    }
  }
  if (propNames.size === 0) throw new Error('no color props found')
  return { components, propNames: [...propNames].sort() }
}
