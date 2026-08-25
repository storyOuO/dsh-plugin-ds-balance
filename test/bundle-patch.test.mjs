/**
 * Verify the bundle patch (cordis.patch.yml) carries the expected plugin row
 * and that package.json declares the bundle manifest and ships the file.
 * String-based on purpose: the patch is a tiny document and the package has
 * zero runtime dependencies, so no YAML parser is worth adding.
 * Run: npm test (or: node test/bundle-patch.test.mjs)
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg)
    process.exit(1)
  }
  console.log('ok: ' + msg)
}

assert(patch.includes('- insert:'), 'patch has an insert list')
assert(patch.includes('- id: ds-balance'), 'patch inserts the ds-balance row')
assert(patch.includes("name: 'ds-balance'"), 'patch names the resolvable package')
assert(patch.includes('config: {}'), 'row carries an explicit empty config (defaults)')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json declares dsh.bundle.patch')
assert(pkg.exports?.['./cordis.patch.yml'] === './cordis.patch.yml', 'exports the patch subpath')
assert(Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'), 'files ships the patch')

console.log('BUNDLE PATCH OK')
