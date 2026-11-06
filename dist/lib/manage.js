'use strict'
// Rule and playbook management from the panel. The files stay the single source of truth (hand
// edits, git and Claude's edits keep working), so every write here is done by the host, never the
// panel, and follows the same rules:
//
// - Paths are only ever `<folder>/autopilot-rules.json`, `<folder>/base.md` and `<folder>/playbooks/<name>.md` with `name`
//   checked against the loader's PLAYBOOK_NAME (no dot, no slash: no `..`, no absolute path). A
//   name from the panel is never joined unchecked. A v1 `rules.json` in the same folder is never
//   written: v2 has its own file name (design-v2 "Migration from v1").
// - Every function takes the folder of ONE level (project or global); the host picks it. Each file
//   has its own hash check, so an edit of one level never touches the other's file.
// - A symbolic link as the target (the rules file, playbooks/, a playbook) is refused: a rename would
//   replace the person's link with a plain file, which is never what they meant.
// - Atomic: the text goes to a temp file in the same folder (same file system), then a rename over
//   the target, so a crash or a full disk never leaves half a rules file. The temp file is removed
//   when anything fails.
// - Concurrency (the host): every rules write names the content hash the panel was shown; the
//   host compares it with the one it last read and with the file on disk now, and refuses with
//   "changed on disk: reloaded" when either differs, so a hand edit is never overwritten.
// - A save rewrites only the entries it edits: every other entry of the file, an invalid one
//   included, is written back exactly as it was parsed (pretty-printed, 2 spaces, a trailing
//   newline). A file that is not a JSON list is never rewritten.
// - Caps: the rules file 512 KiB and 200 rules, a playbook 64 KiB, base.md 16 KiB (schema.js, the loader's own).

const crypto = require('node:crypto')
const path = require('node:path')
const S = require('./schema')
const { hashText } = require('./rules')

const STALE = 'changed on disk: reloaded'

/** A refusal the panel shows as is. `stale`: the file changed on disk; `fieldErrors`: per form field. */
class ManageError extends Error {
  constructor(message, extra = {}) {
    super(message)
    Object.assign(this, extra)
  }
}
const refuse = (m, extra) => {
  throw new ManageError(m, extra)
}

const rulesText = (arr) => `${JSON.stringify(arr, null, 2)}\n`
const bytes = (s) => Buffer.byteLength(s, 'utf8')
const kib = (n) => `${n / 1024} KiB`

async function lstatOrNull(fs, p) {
  try {
    return await fs.lstat(p)
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

/** The target's lstat, or null when it does not exist; a link or a non-file is refused. */
async function checkTarget(fs, file, label) {
  const st = await lstatOrNull(fs, file)
  if (!st) return null
  if (st.isSymbolicLink()) refuse(`${label} is a symbolic link: Autopilot does not write through links (edit it by hand)`)
  if (!st.isFile()) refuse(`${label} is not a regular file`)
  return st
}

/** The folder itself must be a directory (a link to one is fine: it is the person's setting). */
async function checkFolder(fs, folder) {
  let st
  try {
    st = await fs.stat(folder)
  } catch (e) {
    if (e && e.code === 'ENOENT') refuse(`folder ${folder} not found: create it first`)
    throw e
  }
  if (!st.isDirectory()) refuse(`${folder} is not a folder`)
}

/** `<folder>/playbooks`, made when `create` and absent; a link or a non-folder is refused. */
async function playbooksDir(fs, folder, create) {
  const dir = path.join(folder, S.PLAYBOOKS_DIR)
  const st = await lstatOrNull(fs, dir)
  if (!st) {
    if (!create) return null
    await fs.mkdir(dir)
    return dir
  }
  if (st.isSymbolicLink()) refuse(`${S.PLAYBOOKS_DIR}/ is a symbolic link: Autopilot does not write through links`)
  if (!st.isDirectory()) refuse(`${S.PLAYBOOKS_DIR} is not a folder`)
  return dir
}

/**
 * Write `text` to `file` atomically: a temp file next to it (`wx`, so never an existing file), then
 * a rename over the target. Refuses a link as the target; `mustNotExist` refuses any existing one.
 * The temp file is removed when the write or the rename fails.
 */
async function atomicWrite(fs, file, text, { label, mustNotExist = false, randomBytes = crypto.randomBytes } = {}) {
  const st = await checkTarget(fs, file, label || path.basename(file))
  if (st && mustNotExist) refuse(`${label || path.basename(file)} already exists`)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${Buffer.from(randomBytes(6)).toString('hex')}.tmp`)
  try {
    // An existing file keeps its permissions.
    await fs.writeFile(tmp, text, { flag: 'wx', mode: st ? st.mode & 0o777 : 0o644 })
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

// ---- the rules file (autopilot-rules.json) ----

/**
 * The rules file now: `{ exists, hash, raw, list }` (`list`: the parsed value is a JSON list, the only
 * kind the panel rewrites). Read the way the loader reads it, so the hashes compare.
 */
async function readRulesFile(fs, folder) {
  const file = path.join(folder, S.RULES_FILE)
  let src
  try {
    src = await fs.readFile(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, hash: null, raw: null, list: false }
    throw e
  }
  let raw = null
  try {
    raw = JSON.parse(src.replace(/^\ufeff/, ''))
  } catch {
    raw = null
  }
  return { exists: true, hash: hashText(src), raw, list: Array.isArray(raw) }
}

/** The whole list written back, after the caps. */
async function writeRulesFile(fs, folder, arr, randomBytes, { create = false } = {}) {
  if (arr.length > S.MAX_RULES) refuse(`at most ${S.MAX_RULES} rules in ${S.RULES_FILE}`)
  const text = rulesText(arr)
  if (bytes(text) > S.MAX_RULES_BYTES) refuse(`${S.RULES_FILE} would be over ${kib(S.MAX_RULES_BYTES)}`)
  await atomicWrite(fs, path.join(folder, S.RULES_FILE), text, { label: S.RULES_FILE, mustNotExist: create, randomBytes })
}

/** The entry the panel means: at `index`, with the id it showed (null for one with no readable id). */
function entryAt(raw, index, id) {
  if (!Number.isInteger(index) || index < 0 || index >= raw.length) refuse(STALE, { stale: true })
  if (S.idOf(raw[index]) !== (typeof id === 'string' ? id : null)) refuse(STALE, { stale: true })
  return raw[index]
}

/** `entry` with `enabled` set: in its place when it has one, else after `name` or `id`. */
function withEnabled(entry, enabled) {
  if (Object.hasOwn(entry, 'enabled')) return { ...entry, enabled }
  const out = {}
  const after = Object.hasOwn(entry, 'name') ? 'name' : 'id'
  for (const k of Object.keys(entry)) {
    out[k] = entry[k]
    if (k === after) out.enabled = enabled
  }
  if (!Object.hasOwn(out, 'enabled')) out.enabled = enabled
  return out
}

/** The list with one entry switched on or off. */
function applyToggle(raw, { index, id, on }) {
  if (typeof on !== 'boolean') refuse('on must be true or false')
  const entry = entryAt(raw, index, id)
  if (!S.isObj(entry)) refuse('that entry is not a rule object: fix it by hand')
  return raw.map((e, i) => (i === index ? withEnabled(entry, on) : e))
}

/** The list without one entry (valid or not). */
function applyDelete(raw, { index, id }) {
  entryAt(raw, index, id)
  return raw.filter((_, i) => i !== index)
}

/**
 * The list with a rule from the form saved: replaced at `index` (an edit) or added at the end
 * (`index` null). The rule is checked with the loader's own checkRule, its id must be unique among
 * every other entry (valid or not), and it is written in canonical key order with the edited
 * entry's unknown keys kept (schema.js canonicalRule). Refuses with `fieldErrors` for the form.
 */
function applySave(raw, { index, id, rule }) {
  const edit = index !== null && index !== undefined
  const original = edit ? entryAt(raw, index, id) : null
  if (!S.isObj(rule)) refuse('the rule must be an object')
  const c = S.checkRule(rule)
  const fieldErrors = {}
  for (const e of c.errors) if (!fieldErrors[e.field]) fieldErrors[e.field] = e.message
  if (c.rule && raw.some((e, i) => (!edit || i !== index) && S.idOf(e) === c.rule.id)) fieldErrors.id = `id ${S.quote(c.rule.id)} is used by another rule`
  const keys = Object.keys(fieldErrors)
  if (keys.length) refuse(`the rule is not valid: ${fieldErrors[keys[0]]}`, { fieldErrors })
  if (!edit && raw.length >= S.MAX_RULES) refuse(`at most ${S.MAX_RULES} rules in ${S.RULES_FILE}`)
  // The edited entry's unknown keys come back (a save never drops something silently). A v1 `match`
  // copied into the new file is such a key too: kept, and warned about until the person removes it.
  const out = S.canonicalRule(rule, original)
  return edit ? raw.map((e, i) => (i === index ? out : e)) : [...raw, out]
}

// ---- the CLI's edits (`ccc autopilot rules ...`): the same checks as a panel save, by position or id ----

/**
 * The entry a CLI word means: digits only is the 1-based position in the rules file (every entry counts,
 * an invalid one too, as `rule 2 (...)` in the problem lines and `ccc autopilot rules` print it),
 * anything else an id. An id that is all digits is therefore reached by its position. Resolves
 * `{ index, id }`, the pair applyToggle, applyDelete and applySave expect.
 */
function locateEntry(raw, sel) {
  if (/^\d{1,6}$/.test(sel)) {
    const n = Number(sel)
    if (n < 1 || n > raw.length) refuse(`no rule ${n}: ${S.RULES_FILE} has ${raw.length} ${raw.length === 1 ? 'entry' : 'entries'}`)
    return { index: n - 1, id: S.idOf(raw[n - 1]) }
  }
  const index = raw.findIndex((e) => S.idOf(e) === sel)
  if (index < 0) refuse(`no rule with id ${S.quote(sel, 64)} in ${S.RULES_FILE}`)
  return { index, id: sel }
}

/** The list with a new rule added at the end, or at position `at` (1 = first) when given. */
function applyAdd(raw, { rule, at }) {
  const next = applySave(raw, { index: null, id: null, rule })
  if (at === null || at === undefined) return next
  if (!Number.isInteger(at) || at < 1 || at > raw.length + 1) refuse(`--at ${at}: ${S.RULES_FILE} has ${raw.length} ${raw.length === 1 ? 'entry' : 'entries'}, so the place is 1 to ${raw.length + 1}`)
  return [...raw.slice(0, at - 1), next[next.length - 1], ...raw.slice(at - 1)]
}

/**
 * Where `rule` goes when it replaces the entry `sel`, and what is written: `{ index, id, rule }`. What
 * the JSON leaves out of identity stays: the id, and `enabled` (replacing a rule must not quietly
 * switch it on). Everything else is the new JSON's, so a key it does not name goes back to its default.
 */
function setTarget(raw, { sel, rule }) {
  const { index, id } = locateEntry(raw, sel)
  if (!S.isObj(rule)) refuse('the rule must be an object')
  const old = raw[index]
  const keep = {}
  if (S.isObj(old) && !Object.hasOwn(rule, 'enabled') && typeof old.enabled === 'boolean') keep.enabled = old.enabled
  if (!Object.hasOwn(rule, 'id') && id !== null) keep.id = id
  return { index, id, rule: { ...keep, ...rule } }
}

/** The list with the entry `sel` replaced by `rule` (see setTarget), checked as a panel save is. */
function applySet(raw, { sel, rule }) {
  return applySave(raw, setTarget(raw, { sel, rule }))
}

/** The list with entry `sel` moved to position `to`. */
function applyMove(raw, { sel, to }) {
  const { index } = locateEntry(raw, sel)
  if (!Number.isInteger(to) || to < 1 || to > raw.length) refuse(`the place is 1 to ${raw.length}`)
  const rest = raw.filter((_, i) => i !== index)
  return [...rest.slice(0, to - 1), raw[index], ...rest.slice(to - 1)]
}

// ---- playbooks ----

/** `<folder>/playbooks/<name>.md` for a checked name; anything else is refused. */
function playbookPath(folder, name) {
  if (typeof name !== 'string' || !S.PLAYBOOK_NAME.test(name)) refuse('a playbook name is 1-64 letters, digits, "_" or "-", starting with a letter or digit (no dot, no slash)', { fieldErrors: { name: 'a playbook name is 1-64 letters, digits, "_" or "-" (no dot, no slash)' } })
  const dir = path.join(folder, S.PLAYBOOKS_DIR)
  const file = path.join(dir, `${name}.md`)
  // The belt to the pattern: the file is directly in playbooks/.
  if (path.dirname(file) !== dir) refuse('bad playbook name')
  return file
}

/** The rules (any entry of the file, valid or not) that name `name` as their playbook. */
function usedBy(raw, name) {
  if (!Array.isArray(raw)) return []
  return raw.map((e, i) => (S.isObj(e) && e.playbook === name ? S.idOf(e) || `rule ${i + 1}` : null)).filter(Boolean)
}

/**
 * The playbooks in the folder for the panel: `[{ name, size, usedBy, link?, invalid? }]`, sorted.
 * A file whose name the loader cannot use (`a.b.md`) or a link is listed but cannot be edited.
 */
async function listPlaybooks(fs, folder, raw) {
  const dir = path.join(folder, S.PLAYBOOKS_DIR)
  let names
  try {
    names = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const d of names) {
    if (!d.name.endsWith('.md') || d.name.startsWith('.')) continue
    // As many as rules can name; the state message to the panel stays small.
    if (out.length >= S.MAX_RULES) break
    const name = d.name.slice(0, -3)
    const row = { name, size: 0, usedBy: usedBy(raw, name) }
    if (!S.PLAYBOOK_NAME.test(name)) row.invalid = true
    if (d.isSymbolicLink()) row.link = true
    else if (!d.isFile()) continue
    else row.size = await fs.lstat(path.join(dir, d.name)).then((st) => st.size, () => 0)
    out.push(row)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** A playbook's text for the editor, with its hash (a link or an oversized file is refused). */
async function readPlaybook(fs, folder, name) {
  const file = playbookPath(folder, name)
  const st = await checkTarget(fs, file, `${S.PLAYBOOKS_DIR}/${name}.md`)
  if (!st) refuse(`${S.PLAYBOOKS_DIR}/${name}.md not found`)
  if (st.size > S.MAX_PLAYBOOK_BYTES) refuse(`${S.PLAYBOOKS_DIR}/${name}.md is over ${kib(S.MAX_PLAYBOOK_BYTES)}: edit it by hand`)
  const body = await fs.readFile(file, 'utf8')
  return { name, body, hash: hashText(body) }
}

/** Text as it is written: LF line ends, one trailing newline. */
const playbookText = (body) => `${String(body).replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`

/**
 * Save a playbook. `create`: a new file, refused when one exists. Else an edit: the file must be
 * the one the editor opened (`hash`), else "changed on disk" with the hash now (so the person can
 * choose to save over it). Resolves the new hash.
 */
async function writePlaybook(fs, folder, { name, body, create, hash }, randomBytes) {
  const file = playbookPath(folder, name)
  if (typeof body !== 'string' || !body.trim()) refuse('the playbook is empty', { fieldErrors: { body: 'the playbook is empty' } })
  const text = playbookText(body)
  if (bytes(text) > S.MAX_PLAYBOOK_BYTES) refuse(`a playbook is at most ${kib(S.MAX_PLAYBOOK_BYTES)}`, { fieldErrors: { body: `over ${kib(S.MAX_PLAYBOOK_BYTES)}` } })
  // A level whose folder is set but not made yet gets it (and playbooks/) with its first playbook.
  await fs.mkdir(folder, { recursive: true })
  await checkFolder(fs, folder)
  await playbooksDir(fs, folder, true)
  const label = `${S.PLAYBOOKS_DIR}/${name}.md`
  if (create) {
    if (await lstatOrNull(fs, file)) refuse(`a playbook named ${name} exists: edit that one`, { fieldErrors: { name: `${name} exists` } })
  } else {
    await checkTarget(fs, file, label)
    const now = await fs.readFile(file, 'utf8').then(hashText, (e) => (e && e.code === 'ENOENT' ? null : Promise.reject(e)))
    if (now !== hash) refuse(STALE, { stale: true, hash: now })
  }
  await atomicWrite(fs, file, text, { label, mustNotExist: create, randomBytes })
  return hashText(text)
}

/** Delete a playbook: refused while a rule in the rules file (valid or not) names it, or for a link. */
async function deletePlaybook(fs, folder, name, raw) {
  const file = playbookPath(folder, name)
  const users = usedBy(raw, name)
  if (users.length) refuse(`playbook ${name} is used by: ${users.join(', ')}. Change or delete those rules first.`, { usedBy: users })
  const st = await checkTarget(fs, file, `${S.PLAYBOOKS_DIR}/${name}.md`)
  if (!st) refuse(STALE, { stale: true })
  await fs.unlink(file)
}

/**
 * A new playbook's first text (the rule form's "New playbook…"). For an act-mode rule it has the
 * "Allowed actions" heading with a comment and no list item, so the rule stays a problem ("needs an
 * Allowed actions section") until the person lists what the session may do: a stub never grants one.
 */
const playbookStub = (name, mode) =>
  `# ${name}\n\nWhat the session checks, how, and what it reports. Name the places it may check itself (your hosts, projects), so it never takes one from the item.\n${mode === 'act' ? `\n## ${S.ALLOWED_ACTIONS}\n\n<!-- One action per line as a Markdown list ("- ..."), each with its exact target. The session may do only these, on this item only; anything else it reports as a recommendation. -->\n` : ''}`

// ---- base.md: the person's standing instructions for every session of the level ----

/** `<folder>/base.md` now: `{ exists, body, hash }` (body '' and hash null when there is none); a link or an oversized file is refused. */
async function readBase(fs, folder) {
  const file = path.join(folder, S.BASE_FILE)
  const st = await checkTarget(fs, file, S.BASE_FILE)
  if (!st) return { exists: false, body: '', hash: null }
  if (st.size > S.MAX_BASE_BYTES) refuse(`${S.BASE_FILE} is over ${kib(S.MAX_BASE_BYTES)}: edit it by hand`)
  const body = await fs.readFile(file, 'utf8')
  return { exists: true, body, hash: hashText(body) }
}

/**
 * Save `<folder>/base.md`: refused unless the file is the one the editor (or the CLI) read, by `hash`
 * (null: it was absent), so a hand edit is never overwritten; an empty text removes the file. Resolves
 * the new hash, or null when the file was removed (or was not there).
 */
async function writeBase(fs, folder, { body, hash }, randomBytes) {
  if (typeof body !== 'string') refuse('the text must be a string', { fieldErrors: { body: 'not text' } })
  const file = path.join(folder, S.BASE_FILE)
  const st = await checkTarget(fs, file, S.BASE_FILE)
  const now = st ? hashText(await fs.readFile(file, 'utf8')) : null
  if (now !== (hash === undefined ? null : hash)) refuse(STALE, { stale: true, hash: now })
  if (!body.trim()) {
    if (st) await fs.unlink(file)
    return null
  }
  const text = playbookText(body)
  if (bytes(text) > S.MAX_BASE_BYTES) refuse(`${S.BASE_FILE} is at most ${kib(S.MAX_BASE_BYTES)}`, { fieldErrors: { body: `over ${kib(S.MAX_BASE_BYTES)}` } })
  await fs.mkdir(folder, { recursive: true })
  await checkFolder(fs, folder)
  await atomicWrite(fs, file, text, { label: S.BASE_FILE, mustNotExist: !st, randomBytes })
  return hashText(text)
}

// ---- a new folder ----

/** Make the folder with an empty rules file (`[]`) and playbooks/. Refuses when one exists (a v1 rules.json beside it is left alone). */
async function createFolder(fs, folder, randomBytes) {
  await fs.mkdir(folder, { recursive: true })
  await checkFolder(fs, folder)
  await playbooksDir(fs, folder, true)
  await atomicWrite(fs, path.join(folder, S.RULES_FILE), rulesText([]), { label: S.RULES_FILE, mustNotExist: true, randomBytes })
}

/**
 * Copy the plugin's examples/ into the folder (made when missing), every rule switched off, so
 * nothing fires before the person has changed them and seen a dry run. Only into a folder with no
 * rules yet (no rules file, or `[]`); an existing playbook of the same name is kept, not replaced.
 * Resolves `{ rules, playbooks, kept }`.
 */
async function addExamples(fs, folder, examplesDir, randomBytes) {
  const src = JSON.parse(await fs.readFile(path.join(examplesDir, S.RULES_FILE), 'utf8'))
  await fs.mkdir(folder, { recursive: true })
  await checkFolder(fs, folder)
  const cur = await readRulesFile(fs, folder)
  if (cur.exists && !(cur.list && cur.raw.length === 0)) refuse(`${S.RULES_FILE} already has rules: the examples go only into an empty folder (see the plugin's examples/)`)
  const dir = await playbooksDir(fs, folder, true)
  const kept = []
  let copied = 0
  const from = path.join(examplesDir, S.PLAYBOOKS_DIR)
  for (const n of await fs.readdir(from)) {
    if (!n.endsWith('.md') || !S.PLAYBOOK_NAME.test(n.slice(0, -3))) continue
    if (await lstatOrNull(fs, path.join(dir, n))) {
      kept.push(n.slice(0, -3))
      continue
    }
    await atomicWrite(fs, path.join(dir, n), await fs.readFile(path.join(from, n), 'utf8'), { label: `${S.PLAYBOOKS_DIR}/${n}`, mustNotExist: true, randomBytes })
    copied++
  }
  const rules = src.map((r) => (S.isObj(r) ? withEnabled(r, false) : r))
  await writeRulesFile(fs, folder, rules, randomBytes)
  return { rules: rules.length, playbooks: copied, kept }
}

module.exports = {
  STALE,
  ManageError,
  rulesText,
  atomicWrite,
  readRulesFile,
  writeRulesFile,
  locateEntry,
  applyAdd,
  setTarget,
  applySet,
  applyMove,
  applyToggle,
  applyDelete,
  applySave,
  playbookPath,
  usedBy,
  listPlaybooks,
  readPlaybook,
  writePlaybook,
  deletePlaybook,
  playbookStub,
  readBase,
  writeBase,
  createFolder,
  addExamples,
}
