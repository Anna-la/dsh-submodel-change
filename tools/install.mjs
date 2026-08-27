/**
 * tools/install.mjs - install the dsh-submodel-change plugin into the active desktop profile (default: web).
 *
 * Why junction + package name instead of `name: file:///...`:
 *   The desktop profile loader only treats a patch row as an installed bundle when its
 *   `name` resolves to a real package (package.json present). A file:// URL row is flagged
 *   as "not installed" by the profile consistency check and is loaded too early / without
 *   the userQuestions / llm / agents services, so the plugin silently no-ops.
 *   token-stat had exactly this problem; its tools/install.mjs is the pattern this follows.
 *
 * Steps:
 *   1) create profiles/<profile>/node_modules/@jason666not/dsh-submodel-change -> <project root>
 *      (a junction; pnpm / official directory cleanup will not touch it)
 *   2) rewrite profiles/<profile>/cordis.patch.yml: the submodel-change row's name
 *      becomes the package name '@jason666not/dsh-submodel-change'
 *   3) verify the package resolves from the profile
 *
 * Idempotent; safe to re-run.
 * Usage: node tools/install.mjs [profileName]
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // <project>/tools
const pkgDir = path.dirname(here)                          // <project> (= package root)
const profileName = process.argv[2] || 'web'
const PKG_NAME = '@jason666not/dsh-submodel-change'
const ID_PATTERN = /^-\s*id:\s*['"]?submodel-change['"]?\s*$/

function dshHome() {
  const env = process.env.DSH_HOME
  if (env && env.trim().length > 0) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

const profileDir = path.join(dshHome(), 'profiles', profileName)
const nmDir = path.join(profileDir, 'node_modules')
const scopeDir = path.join(nmDir, '@jason666not')
const linkPath = path.join(scopeDir, 'dsh-submodel-change')
const patchFile = path.join(profileDir, 'cordis.patch.yml')

function fail(message) {
  console.error(`[install] FAILED: ${message}`)
  process.exit(1)
}

console.log(`[install] profile: ${profileName} -> ${profileDir}`)
if (!fs.existsSync(path.join(pkgDir, 'package.json'))) fail(`cannot find package.json in ${pkgDir}`)
if (!fs.existsSync(path.join(pkgDir, 'index.mjs'))) fail(`missing ${pkgDir}\\index.mjs`)
if (!fs.existsSync(patchFile)) fail(`cannot find ${patchFile} (check profile '${profileName}' exists)`)

// ----- step 1: junction -----
const pkgReal = fs.realpathSync(pkgDir)
if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
  let real
  try { real = fs.realpathSync(linkPath) } catch { real = null }
  if (real === pkgReal) {
    console.log('[install] junction already correct:', linkPath)
  } else {
    console.log('[install] removing stale link:', linkPath)
    fs.rmSync(linkPath, { recursive: true, force: true })
    fs.mkdirSync(scopeDir, { recursive: true })
    fs.symlinkSync(pkgDir, linkPath, 'junction')
    console.log('[install] recreated junction ->', pkgDir)
  }
} else {
  fs.mkdirSync(scopeDir, { recursive: true })
  fs.symlinkSync(pkgDir, linkPath, 'junction')
  console.log('[install] created junction:', linkPath, '->', pkgDir)
}

// ----- step 2: patch row name -> package name -----
const raw = fs.readFileSync(patchFile, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)
const expected = `name: '${PKG_NAME}'`

let blockIndex = -1
for (let i = 0; i < lines.length; i++) {
  if (ID_PATTERN.test(lines[i].trim())) { blockIndex = i; break }
}
if (blockIndex >= 0) {
  let nameFound = false
  for (let j = blockIndex + 1; j < Math.min(blockIndex + 4, lines.length); j++) {
    const nameLine = lines[j].trim()
    if (/^name:\s*/.test(nameLine)) {
      if (nameLine !== expected) {
        const indent = lines[j].match(/^\s*/)[0]
        lines[j] = indent + expected
        console.log(`[install] patch row name -> ${expected}`)
      } else {
        console.log('[install] patch row already uses package name')
      }
      nameFound = true
      break
    }
  }
  if (!nameFound) throw new Error('submodel-change row has no name line')
} else {
  // append a new insert block at the end
  const block = [
    '# dsh-submodel-change plugin (package-name install: run node tools/install.mjs first)',
    '- insert:',
    '    - id: submodel-change',
    `      ${expected}`,
  ]
  const tail = raw.endsWith(eol) ? '' : eol
  fs.writeFileSync(patchFile, raw + tail + eol + block.join(eol) + eol, 'utf8')
  console.log('[install] appended submodel-change insert to cordis.patch.yml')
}
const next = lines.join(eol)
if (next !== raw) fs.writeFileSync(patchFile, next, 'utf8')

// ----- step 3: verify resolution -----
const req = createRequire(path.join(profileDir, '__probe__.cjs'))
const probe = (label, spec) => {
  try {
    const resolved = req.resolve(spec)
    console.log(`[install] resolve OK: ${label} -> ${resolved}`)
    return resolved
  } catch (error) {
    fail(`resolve ${label}: ${error.message}`)
  }
}
probe('package', PKG_NAME)
const pkgJson = probe('package.json', `${PKG_NAME}/package.json`)
const manifest = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
if (!manifest.dsh?.bundle) fail('package.json must declare "dsh": { "bundle": { "patch": ... } }')
console.log('[install] done. Restart the app (or trigger HMR) for the plugin to activate.')