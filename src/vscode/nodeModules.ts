import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Nearest node_modules/<pkg> starting at startDir and walking up to stopDir
 * (inclusive). Monorepos commonly hoist dependencies to the repo root, so the
 * quasar app directory and its installed packages can live apart.
 */
export function findInstalledPackage(pkg: string, startDir: string, stopDir: string): string | undefined {
  let dir = startDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkg)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // not here: keep walking up
    }
    if (dir === stopDir) return undefined
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** does dir/package.json declare quasar as a (dev)dependency? */
export function hasQuasarDependency(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return Boolean(pkg.dependencies?.quasar ?? pkg.devDependencies?.quasar)
  } catch {
    return false
  }
}
