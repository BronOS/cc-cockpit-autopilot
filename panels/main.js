'use strict'
// The Autopilot panel: renders the host's `{ type: 'state' }` message (the switch, problems, then
// the tabs Rules, Playbooks and Log) and posts the person's clicks back. Every string that came from
// a file, a feed or the host goes in through textContent, never as markup. The models come from
// viewlogic.js (pure, tested) and the rule format from ../dist/lib/schema.js (the loader's own);
// this file only builds elements and handles input. The title bar (on/off, rule count, refresh) is
// the app's, from the host's ctx.panels.header.
//
// Edits are never written here: the panel posts one (`saveRule`, `toggleRule`, `savePlaybook`, ...)
// with a request number, its level (project or global) and the content hash of that level's file it
// was shown, the host checks it, writes the file and answers `{ type: 'result', req, ok, error?,
// stale?, fieldErrors? }` after the fresh state. Both levels' rules are listed, each with its tag.
//
// The render gate: a state message arrives on every refresh (60 s, a feed change, another window),
// and a redraw replaces every element. So while the rule form or the playbook editor is open the
// page is not redrawn at all (the state is kept and shows when the form closes), and otherwise a
// redraw waits while a mouse button is down (viewlogic.js createRenderGate, as in Inbox).

let state = null
const ui = { tab: 'rules', confirm: null, notice: null, noticeKind: 'error', busy: null, form: null, pb: null, formMsg: null }
let noticeTimer = null
let reqSeq = 0
const pending = new Map()

const gate = createRenderGate(() => render())
document.addEventListener('pointerdown', () => gate.down(), true)
document.addEventListener('pointerup', () => gate.up(), true)
document.addEventListener('pointercancel', () => gate.up(), true)

const root = () => document.getElementById('root')
const post = (type, extra) => ccPanel.post({ type, ...extra })
const formOpen = () => Boolean(ui.form || ui.pb)

/** Post an edit; `done(result)` runs when the host answers it. */
function request(type, extra, done) {
  const req = ++reqSeq
  pending.set(req, done || (() => {}))
  post(type, { req, ...extra })
}

function el(tag, props, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c)
  return n
}

function button(text, onclick, title, cls, disabled) {
  return el('button', { type: 'button', title, class: cls, disabled: Boolean(disabled) || ui.busy !== null, onclick }, text)
}

const label = (text, small) => el('div', { class: 'lbl' }, el('span', { text }), small ? el('small', { text: small }) : null)

/** A short message: in the open form's message line, else at the top of the page for 8 s. */
function showNotice(text, kind = 'error') {
  if (formOpen() && ui.formMsg) {
    ui.formMsg.textContent = text
    ui.formMsg.className = `notice ${kind}`
    ui.formMsg.hidden = !text
    return
  }
  ui.notice = text
  ui.noticeKind = kind
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    ui.notice = null
    if (!formOpen()) gate.request()
  }, 8000)
  gate.request()
}

function toggleBox(on, aria, disabled) {
  const box = el('input', { type: 'checkbox', class: 'toggle', role: 'switch', 'aria-label': aria, disabled: Boolean(disabled) })
  box.checked = on
  return box
}

// ---- the top: switch, folder, problems ----

function switchCard() {
  const m = switchModel(state)
  const box = toggleBox(m.on, 'Autopilot on', ui.busy !== null)
  box.addEventListener('change', () => {
    ui.busy = 'toggle'
    post('toggle', { on: box.checked })
    render()
  })
  const card = el('div', { class: 'card' }, el('div', { class: 'field' }, label(m.label, m.hint), el('div', { class: 'ctl' }, box)))
  for (const f of folderRows(state)) card.append(el('div', { class: 'field' }, label(f.label, f.hint), el('div', { class: 'ctl path', text: f.path, title: f.path })))
  return card
}

/** One level's missing-folder card (viewlogic folderModel), or null. */
function folderCard(lv) {
  const f = folderModel(lv)
  if (!f) return null
  const done = (what) => (res) => showNotice(res.ok ? what(res) : res.error, res.ok ? 'info' : 'error')
  const level = { level: f.level }
  const bar = el('div', { class: 'bar' },
    f.create ? button(f.create, () => request('createFolder', level, done((r) => `Made ${r.folder} with an empty autopilot-rules.json and playbooks/.`)), f.create === 'Create folder' ? 'Make the folder with autopilot-rules.json ([]) and playbooks/' : 'Write autopilot-rules.json ([]) in the folder, and make playbooks/ when it is missing') : null,
    f.examples ? button('Add the example rules', () => request('addExamples', level, done((r) => `Added ${r.rules} example rule${r.rules === 1 ? '' : 's'} (switched off) and ${r.playbooks} playbook${r.playbooks === 1 ? '' : 's'} to the ${r.level} rules${r.kept.length ? `; kept your ${r.kept.join(', ')}` : ''}.`)), 'Copy the plugin\'s examples/, every rule switched off') : null)
  return el('div', { class: 'card' }, el('div', { class: 'field' }, el('div', { class: 'lbl' }, el('span', { text: f.text }), el('small', { text: f.hint }), bar)))
}

/** The hash of a level's rules file as the panel was shown it (a write names it). */
const hashOf = (level) => levelState(state, level).rulesHash

function tabBar() {
  const bar = el('div', { class: 'tabs', role: 'tablist' })
  for (const t of tabsModel(state, ui.tab)) {
    bar.append(el('button', { type: 'button', role: 'tab', 'aria-selected': t.active ? 'true' : 'false', onclick: () => { ui.tab = t.id; ui.confirm = null; render() } }, t.label))
  }
  return bar
}

// ---- Rules ----

function ruleRow(r) {
  const lbl = el('div', { class: 'lbl' }, el('b', { text: r.name }), el('span', { class: `tag ${r.tag}`, text: r.tag }), r.summary ? el('small', { text: r.summary }) : null)
  for (const w of r.warnings) lbl.append(el('div', { class: 'warn', text: `⚠ ${w}` }))
  if (r.outsiders) lbl.append(el('div', { class: 'warn', text: `⚠ ${r.outsiders}` }))
  if (r.problem) lbl.append(el('div', { class: 'problem', text: r.problem }))
  const c = ui.confirm
  if (c && c.kind === 'rule' && c.level === r.level && c.index === r.index && c.id === r.id) {
    lbl.append(el('div', { class: 'confirm' }, el('span', { text: confirmText('rule', r.name) }),
      button('Delete', () => {
        ui.busy = 'rule'
        request('deleteRule', { level: r.level, index: r.index, id: r.id, hash: hashOf(r.level) }, (res) => {
          ui.confirm = null
          if (res.ok) showNotice(`Deleted rule ${r.ref}.`, 'info')
          else showNotice(res.error)
        })
        render()
      }, `Remove this entry from the ${r.level} autopilot-rules.json`, 'danger'),
      button('Cancel', () => { ui.confirm = null; render() })))
  }
  const box = toggleBox(r.on, `Rule ${r.name} on`, !r.canToggle || ui.busy !== null)
  box.addEventListener('change', () => {
    ui.busy = 'rule'
    request('toggleRule', { level: r.level, index: r.index, id: r.id, on: box.checked, hash: hashOf(r.level) }, (res) => {
      if (!res.ok) showNotice(res.error)
    })
    render()
  })
  const ctl = el('div', { class: 'ctl actions' },
    r.canEdit ? button('Edit', () => openRuleForm(r), 'Edit this rule in a form') : null,
    r.canDelete ? button('Delete', () => { ui.confirm = { kind: 'rule', level: r.level, index: r.index, id: r.id }; render() }, 'Delete this rule') : null,
    box)
  return el('div', { class: `field${r.on && r.ok ? '' : ' off'}` }, lbl, ctl)
}

function rulesTab() {
  const out = el('div', {})
  const writable = writableLevels(state)
  out.append(el('div', { class: 'bar' },
    button('New rule', () => openRuleForm(null, writable[0] && writable[0].level), writable.length ? 'Write a new rule in a form; you pick its level there' : 'No rules folder is set: set "Global rules folder" (app) or "Project rules folder" (project) in the settings', null, !writable.length),
    button('Ask Claude to write a rule', () => request('askClaude', {}, (res) => showNotice(res.ok ? 'Opened a Claude tab that writes a rule with you.' : res.error, res.ok ? 'info' : 'error')), 'Open a Claude tab that helps you write a rule and its playbook in the files, then dry-runs it')))
  // Both levels, in the order they are checked: project rules first, then global ones.
  for (const lv of levelsOf(state)) {
    if (!lv.folder) continue
    out.append(el('h3', { text: `${lv.label} rules${lv.level === 'project' ? ' (checked first)' : ''}` }))
    if (lv.folderState === 'ok' && !lv.editable) {
      out.append(el('div', { class: 'src-err', text: `The ${lv.level} autopilot-rules.json is not a JSON list of rules: fix it by hand (the panel never rewrites a file it cannot read).` }))
    }
    const rows = ruleRows(state, lv.level)
    if (rows.length) {
      const card = el('div', { class: 'card' })
      for (const r of rows) card.append(ruleRow(r))
      out.append(card)
    } else if (!folderModel(lv)) {
      out.append(el('div', { class: 'card' }, el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: 'No rule.' }))))
    }
  }
  out.append(el('h3', { text: 'Dry run' }), dryBlock())
  return out
}

function dryBlock() {
  const bar = el('div', { class: 'bar' },
    button('Dry run', () => { ui.busy = 'dry'; post('dryRun', { jev: false }); render() }, 'Which current items each rule would fire on, and why. Starts no session and asks Jev nothing.'),
    button('Dry run with Jev', () => { ui.busy = 'dry'; post('dryRun', { jev: true }); render() }, 'The same, asking Jev for rules with a Jev step (at most 10 questions, each a paid request)'),
    state.dry ? button('Clear', () => post('clearDry'), 'Hide the dry run') : null,
    ui.busy === 'dry' ? el('span', { class: 'muted', text: 'Running…' }) : null)
  const m = dryModel(state.dry, Date.now())
  if (!m) return bar
  const card = el('div', { class: 'card' }, el('div', { class: 'field head' }, el('div', { class: 'lbl muted', text: m.head })))
  if (m.off) card.append(el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: 'Autopilot is off: even a "would fire" opens nothing until it is on.' })))
  if (m.empty) card.append(el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: m.empty })))
  for (const r of m.rows) {
    card.append(el('div', { class: 'field' },
      el('div', { class: 'lbl' }, el('span', { class: 'title', text: r.title, title: r.title }), el('small', { text: r.meta }), el('small', { text: r.verdict })),
      el('div', { class: `ctl mark ${r.fire === true ? 'yes' : r.fire === null ? 'maybe' : 'no'}`, text: r.mark })))
  }
  if (m.cut) card.append(el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: m.cut })))
  return el('div', {}, bar, card)
}

// ---- the rule form ----

/** The form for an entry (`row`, of its own level) or a new rule (`row` null) of `level`. */
function openRuleForm(row, level) {
  const lvl = row ? row.level : level
  const entry = row ? (levelState(state, lvl).entries || []).find((e) => e.index === row.index) : null
  ui.form = {
    index: entry ? entry.index : null,
    origId: entry ? entry.id : null,
    base: hashOf(lvl),
    model: formFromRaw(entry ? entry.raw : null, state, lvl),
    warnings: entry ? entry.warnings || [] : [],
    // An existing rule shows all its errors at once; a new one each field's once it was touched.
    showAll: Boolean(entry),
    touched: new Set(),
    sending: false,
    hostErrors: {},
  }
  ui.confirm = null
  render()
}

/** How the "Still needed" line names a field the person has not touched yet. */
const FIELD_NAMES = { id: 'id', sources: 'a source', when: 'a condition or the confirmation', playbook: 'playbook', 'jev.question': 'the Jev question' }

function ruleFormView() {
  const f = ui.form
  const m = f.model
  const errs = new Map()
  const general = el('div', { class: 'err' })
  const errEl = (...keys) => {
    const n = el('div', { class: 'err' })
    for (const k of keys) errs.set(k, n)
    return n
  }
  const save = el('button', { type: 'button', class: 'primary' }, 'Save')
  // Parts of the form that follow the model (the confirmation row shows only for a rule that tests nothing).
  const syncs = []
  const still = el('span', { class: 'muted' })
  const touch = (key) => {
    f.touched.add(key)
    delete f.hostErrors[key]
    check()
  }

  function check() {
    const e = { ...formErrors(m, state, f.index), ...f.hostErrors }
    const by = new Map()
    const hidden = []
    for (const [k, msg] of Object.entries(e)) {
      // 'when[2]' is shown under the conditions block, 'jev.min' under its own row or 'jev'.
      const top = k.split(/[.[]/)[0]
      if (!f.showAll && !f.touched.has(k) && !f.touched.has(top)) {
        hidden.push(FIELD_NAMES[k] || FIELD_NAMES[top] || k)
        continue
      }
      const n = errs.get(k) || errs.get(top) || general
      if (!by.has(n)) by.set(n, [])
      by.get(n).push(msg)
    }
    for (const n of new Set([...errs.values(), general])) n.textContent = (by.get(n) || []).join('; ')
    still.textContent = hidden.length ? `Still needed: ${[...new Set(hidden)].join(', ')}` : ''
    save.disabled = Object.keys(e).length > 0 || f.sending
    for (const fn of syncs) fn()
  }

  const text = (key, errKey, props = {}) => {
    const n = el('input', { type: 'text', spellcheck: 'false', ...props })
    n.value = m[key]
    n.addEventListener('input', () => {
      m[key] = n.value
      touch(errKey)
    })
    return n
  }
  const area = (key, rows, errKey) => {
    const n = el('textarea', { rows, spellcheck: 'false' })
    n.value = m[key]
    n.addEventListener('input', () => {
      m[key] = n.value
      touch(errKey)
    })
    return n
  }
  const select = (key, options, errKey, after) => {
    const n = el('select', {}, ...options.map((o) => el('option', { value: o.value, text: o.label })))
    n.value = m[key]
    n.addEventListener('change', () => {
      m[key] = n.value
      if (after) after()
      touch(errKey)
    })
    return n
  }
  const toggle = (key, aria, after) => {
    const n = toggleBox(m[key], aria, false)
    n.addEventListener('change', () => {
      m[key] = n.checked
      if (after) after()
      touch(key)
    })
    return n
  }
  const row = (name, small, ctl, err) => el('div', { class: 'field' }, el('div', { class: 'lbl' }, el('span', { text: name }), small ? el('small', { text: small }) : null, err), el('div', { class: 'ctl' }, ctl))
  const col = (name, small, ctl, err) => el('div', { class: 'field col' }, el('div', { class: 'lbl' }, el('span', { text: name }), small ? el('small', { text: small }) : null), ctl, err)

  const page = el('div', {})
  page.append(el('h3', { text: f.index === null ? `New ${m.level} rule` : `Edit rule ${m.level}:${f.origId || `rule ${f.index + 1}`}` }))
  ui.formMsg = el('div', { class: 'notice error', hidden: true })
  page.append(ui.formMsg)
  for (const w of f.warnings) page.append(el('div', { class: 'warn', text: `⚠ ${w}` }))

  // A new rule picks its level (an edit keeps the file it is in). The playbook list is the level's
  // own, so a change redraws the form from its model (kept as typed) and rebases on that file's hash.
  const levels = writableLevels(state)
  const levelRow = f.index === null && levels.length > 1
    ? row('Level', 'project: this project only, checked first; global: every project', select('level', levels.map((l) => ({ value: l.level, label: `${l.label} (${l.folder})` })), 'level', () => {
      f.base = hashOf(m.level)
      if (m.playbook !== NEW_PLAYBOOK && !playbookOptions(state, '', m.level).some((o) => o.value === m.playbook)) {
        const first = playbookOptions(state, '', m.level)[0]
        m.playbook = first ? first.value : NEW_PLAYBOOK
      }
      render()
    }), errEl('level'))
    : null
  page.append(el('div', { class: 'card' },
    levelRow,
    row('Id', 'letters, digits, ".", "_" or "-"; unique', text('id', 'id', { maxlength: 64 }), errEl('id')),
    row('Name', 'optional, for you', text('name', 'name', { maxlength: S.MAX_NAME }), errEl('name')),
    row('On', 'a new rule starts off: try it with a dry run first', toggle('enabled', 'Rule on'), errEl('enabled'))))

  // Sources: required. The feeds running now, "Any source", and the rule's own ids that no feed has.
  const srcBox = el('div', { class: 'srcs' })
  const outsiders = el('div', { class: 'warn' })
  const drawSources = () => {
    srcBox.textContent = ''
    const anyBox = el('input', { type: 'checkbox', 'aria-label': 'Any source' })
    anyBox.checked = m.sourceAny
    anyBox.addEventListener('change', () => {
      m.sourceAny = anyBox.checked
      drawSources()
      touch('sources')
    })
    srcBox.append(el('label', { class: 'src' }, anyBox, el('span', { text: 'Any source' }), el('small', { text: 'includes mail, which outsiders can reach' })))
    for (const c of sourceChoices(state, m.sources)) {
      const box = el('input', { type: 'checkbox', 'aria-label': c.label, disabled: m.sourceAny })
      box.checked = m.sources.includes(c.id)
      box.addEventListener('change', () => {
        m.sources = sourceToggle(m.sources, c.id, box.checked)
        drawSources()
        touch('sources')
      })
      srcBox.append(el('label', { class: `src${c.known ? '' : ' gone'}` }, box, el('span', { text: c.label })))
    }
    outsiders.textContent = outsidersCan(m.sourceAny ? [S.ANY_SOURCE] : m.sources, state) ? OUTSIDERS : ''
    outsiders.hidden = !outsiders.textContent
  }
  drawSources()
  page.append(el('h3', { text: 'Sources' }), el('div', { class: 'card' },
    col('Which feeds', 'the rule looks only at items from these; required', srcBox, errEl('sources')),
    el('div', { class: 'field' }, outsiders)))

  // Conditions (all must hold): Inbox's editor. A field or op change redraws the rows (the value
  // control depends on them); typing in a value does not, or it would lose its focus.
  const table = condTable()
  const whenBox = el('div', { class: 'conds' })
  const confirmRow = el('label', { class: 'src' })
  const confirmBox = el('input', { type: 'checkbox', 'aria-label': 'Fire on every new item' })
  confirmBox.checked = m.confirmAll
  confirmBox.addEventListener('change', () => {
    m.confirmAll = confirmBox.checked
    touch('when')
  })
  confirmRow.append(confirmBox, el('span', { text: 'Fire on every new item from these sources' }))
  const addCond = button('Add condition', () => {
    m.when = condAdd(m.when, table)
    drawWhen()
    touch('when')
  }, undefined, null, false)
  const editCond = (i, patch, redraw) => {
    m.when = condSet(m.when, i, patch, table)
    if (redraw) drawWhen()
    touch('when')
  }
  function condRow(c, i) {
    const spec = table.fields[c.field]
    const kind = spec ? spec.value : 'text'
    const pick = (aria, options, value, on) => {
      const n = el('select', { 'aria-label': aria }, ...options.map((o) => el('option', { value: o.value, text: o.label })))
      n.value = value
      n.addEventListener('change', () => on(n.value))
      return n
    }
    const row = el('div', { class: 'cond', role: 'group', 'aria-label': `Condition ${i + 1}` },
      pick(`Condition ${i + 1} field`, condFieldOptions(c, table), str(c.field), (v) => editCond(i, { field: v }, true)),
      pick(`Condition ${i + 1} test`, condOpOptions(c.field, table), str(c.op), (v) => editCond(i, { op: v }, true)))
    const ctl = condControl(c, table)
    const aria = `Condition ${i + 1} value`
    if (ctl.type === 'select') {
      row.append(pick(aria, ctl.options.map((o) => ({ value: o, label: o })), condValueText(c.value), (v) => editCond(i, { value: condParse(v, kind, c.op) }, false)))
    } else if (ctl.type === 'checks') {
      const have = Array.isArray(c.value) ? c.value : []
      const checks = el('span', { class: 'checks', role: 'group', 'aria-label': aria })
      for (const o of ctl.options) {
        const box = el('input', { type: 'checkbox' })
        box.checked = have.includes(o)
        box.addEventListener('change', () => {
          const now = Array.isArray(m.when[i].value) ? m.when[i].value : []
          editCond(i, { value: box.checked ? [...now.filter((x) => x !== o), o] : now.filter((x) => x !== o) }, false)
        })
        checks.append(el('label', {}, box, el('span', { text: o })))
      }
      row.append(checks)
    } else if (ctl.type === 'lines') {
      const ta = el('textarea', { rows: 2, 'aria-label': `${aria}, one per line`, placeholder: 'one per line', spellcheck: 'false' })
      ta.value = condValueText(c.value)
      ta.addEventListener('input', () => editCond(i, { value: condParse(ta.value, kind, c.op) }, false))
      row.append(ta)
    } else {
      const input = el('input', { type: 'text', 'aria-label': aria, spellcheck: 'false', ...(ctl.type === 'number' ? { inputmode: 'numeric' } : { maxlength: ctl.max }) })
      input.value = condValueText(c.value)
      input.addEventListener('input', () => editCond(i, { value: condParse(input.value, kind, c.op) }, false))
      row.append(input)
    }
    row.append(button('Remove', () => {
      m.when = condRemove(m.when, i)
      drawWhen()
      touch('when')
    }, `Remove condition ${i + 1}`, 'ghost'))
    return row
  }
  function drawWhen() {
    whenBox.textContent = ''
    m.when.forEach((c, i) => whenBox.append(condRow(c, i)))
    addCond.disabled = m.when.length >= S.MAX_WHEN
    addCond.title = addCond.disabled ? `At most ${S.MAX_WHEN} conditions` : ''
  }
  drawWhen()
  // Only a rule that tests nothing asks for the confirmation.
  syncs.push(() => {
    confirmRow.hidden = !(m.when.length === 0 && !m.jevOn)
  })
  page.append(el('h3', { text: 'Conditions' }), el('div', { class: 'card' },
    col('When', 'all of these must hold for the item; none and no Jev question: every new item from the sources', el('div', {}, whenBox, el('div', { class: 'bar' }, addCond), confirmRow), errEl('when'))))

  const hoursRows = el('div', {})
  const showHours = () => {
    hoursRows.hidden = m.hoursMode !== 'set'
  }
  const time = (key) => {
    const n = el('input', { type: 'time', class: 'num', 'aria-label': key === 'hoursFrom' ? 'From' : 'To' })
    n.value = m[key]
    n.addEventListener('input', () => {
      m[key] = n.value
      touch('hours.from')
      touch('hours.to')
    })
    return n
  }
  hoursRows.append(row('From', 'start, included; local time of this computer', time('hoursFrom'), errEl('hours.from', 'hours')), row('To', 'end, not included; before From: past midnight', time('hoursTo'), errEl('hours.to')))
  showHours()
  page.append(el('h3', { text: 'Active hours' }), el('div', { class: 'card' },
    row('When', 'outside the hours the rule does not fire, and the item is not kept for later', select('hoursMode', [{ value: 'any', label: 'Any time' }, { value: 'set', label: 'Only between' }], 'hours.from', showHours), null),
    hoursRows))

  const jevRows = el('div', {})
  const showJev = () => {
    jevRows.hidden = !m.jevOn
  }
  jevRows.append(
    col('Question', 'a yes/no question about the item; Jev answers after the conditions hold', area('question', 2, 'jev.question'), errEl('jev.question')),
    row('Min', 'fires at or above this probability (0 to 1)', text('min', 'jev.min', { inputmode: 'decimal', class: 'num' }), errEl('jev.min')))
  showJev()
  page.append(el('h3', { text: 'Jev' }), el('div', { class: 'card' },
    row('Ask Jev', state.jev ? 'one yes/no question, about $0.0002; a rule with a Jev step waits for the answer' : 'Jev not installed: a rule with a Jev step is skipped until bronos.jev is enabled', toggle('jevOn', 'Ask Jev', showJev), errEl('jev')),
    jevRows))

  const newName = el('div', {})
  const showNew = () => {
    newName.hidden = m.playbook !== NEW_PLAYBOOK
  }
  newName.append(row('New playbook name', 'letters, digits, "_" or "-"; it opens in the editor after Save', text('newPlaybook', 'playbook', { maxlength: 64 }), null))
  showNew()
  const note = supportNote(state.takeover)
  page.append(el('h3', { text: 'Session' }), el('div', { class: 'card' },
    row('Playbook', `what the session does: playbooks/<name>.md in the ${m.level} folder`, select('playbook', playbookOptions(state, m.playbook, m.level), 'playbook', showNew), errEl('playbook')),
    newName,
    col('Check', 'optional: what the session checks first against the full item; when it does not hold, it stops', area('check', 3, 'check'), errEl('check')),
    row('Model', note || 'Claude Code\'s alias; Default is your own setting', select('model', choiceOptions(S.MODEL_LIST, m.model), 'model'), errEl('model')),
    row('Effort', note || 'Default is your own setting', select('effort', choiceOptions(S.EFFORT_LIST, m.effort), 'effort'), errEl('effort'))))

  const L = S.LIMITS
  page.append(el('h3', { text: 'Limits' }), el('div', { class: 'card' },
    row('Per day', `sessions in 24 hours, ${L.perDay.min} to ${L.perDay.max}`, text('perDay', 'limits.perDay', { inputmode: 'numeric', class: 'num' }), errEl('limits.perDay', 'limits')),
    row('Cooldown', `minutes between two sessions, ${L.cooldownMinutes.min} to ${L.cooldownMinutes.max}`, text('cooldownMinutes', 'limits.cooldownMinutes', { inputmode: 'numeric', class: 'num' }), errEl('limits.cooldownMinutes')),
    row('Again on change', 'send the item\'s new replies, comments or status into its open tab', toggle('onChange', 'Again on change'), errEl('onChange'))))

  save.addEventListener('click', () => {
    f.showAll = true
    check()
    if (save.disabled) return
    f.sending = true
    check()
    const newPlaybook = m.playbook === NEW_PLAYBOOK
    request('saveRule', { level: m.level, index: f.index, id: f.origId, hash: f.base, rule: formToRule(m), newPlaybook }, (res) => {
      f.sending = false
      if (res.ok) {
        ui.form = null
        ui.formMsg = null
        showNotice(`Saved rule ${m.level}:${res.id}.`, 'info')
        if (res.playbook) openPlaybook(m.level, res.playbook)
        return
      }
      if (res.stale) {
        // The fresh state came first: rebase the form on it and say so. The person decides.
        f.base = hashOf(m.level)
        if (f.origId !== null) {
          const e = (levelState(state, m.level).entries || []).find((x) => x.id === f.origId)
          f.index = e ? e.index : null
        }
        showNotice(`${res.error}: the ${m.level} autopilot-rules.json was changed outside the panel. Your form is kept; Save again writes it into the new version${f.index === null ? ' as a new rule' : ''}, Cancel drops it.`)
      } else showNotice(res.error)
      f.hostErrors = res.fieldErrors || {}
      check()
    })
  })
  page.append(general, el('div', { class: 'bar form-bar' }, save, button('Cancel', () => { ui.form = null; ui.formMsg = null; render() }), still))
  check()
  return page
}

// ---- Playbooks ----

function openPlaybook(level, name) {
  request('openPlaybook', { level, name }, (res) => {
    if (!res.ok) {
      showNotice(res.error)
      return
    }
    ui.pb = { level, name: res.name, isNew: false, body: res.body, hash: res.hash, confirm: false, sending: false }
    ui.tab = 'playbooks'
    render()
  })
}

/** Both levels' playbooks, each level its own list and New button: a playbook serves its own level's rules. */
function playbooksTab() {
  const out = el('div', {})
  for (const lv of levelsOf(state)) {
    if (!lv.folder) continue
    out.append(el('h3', { text: `${lv.label} playbooks` }))
    out.append(el('div', { class: 'bar' }, button('New playbook', () => {
      ui.pb = { level: lv.level, name: '', isNew: true, body: playbookTemplate(), hash: null, confirm: false, sending: false }
      render()
    }, `Write a new playbook in the ${lv.level} folder`, null, lv.folderState === 'missing')))
    out.append(playbookList(lv.level))
  }
  return out
}

function playbookList(level) {
  const rows = playbookRows(state, level)
  if (!rows.length) return el('div', { class: 'card' }, el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: 'No playbook in playbooks/.' })))
  const card = el('div', { class: 'card' })
  for (const r of rows) {
    const lbl = el('div', { class: 'lbl' }, el('b', { text: r.name }), el('small', { text: `${r.used} · ${r.size}` }))
    if (r.note) lbl.append(el('div', { class: 'warn', text: r.note }))
    const c = ui.confirm
    if (c && c.kind === 'playbook' && c.level === level && c.name === r.name) {
      const blocked = deleteBlocked(r)
      if (blocked) lbl.append(el('div', { class: 'confirm' }, el('span', { class: 'problem', text: blocked }), button('OK', () => { ui.confirm = null; render() })))
      else {
        lbl.append(el('div', { class: 'confirm' }, el('span', { text: confirmText('playbook', r.name) }),
          button('Delete', () => {
            ui.busy = 'playbook'
            request('deletePlaybook', { level, name: r.name }, (res) => {
              ui.confirm = null
              showNotice(res.ok ? `Deleted playbook ${r.name}.` : res.error, res.ok ? 'info' : 'error')
            })
            render()
          }, 'Delete the file', 'danger'),
          button('Cancel', () => { ui.confirm = null; render() })))
      }
    }
    card.append(el('div', { class: 'field' }, lbl, el('div', { class: 'ctl actions' },
      r.canEdit ? button('Edit', () => openPlaybook(level, r.name), 'Edit this playbook') : null,
      r.canDelete ? button('Delete', () => { ui.confirm = { kind: 'playbook', level, name: r.name }; render() }, 'Delete this playbook') : null)))
  }
  return card
}

function playbookView() {
  const p = ui.pb
  const page = el('div', {})
  page.append(el('h3', { text: p.isNew ? `New ${p.level} playbook` : `Playbook ${p.name} (${p.level})` }))
  ui.formMsg = el('div', { class: 'notice error', hidden: true })
  page.append(ui.formMsg)
  const nameErr = el('div', { class: 'err' })
  const bodyErr = el('div', { class: 'err' })
  const size = el('small', { class: 'muted' })
  const save = el('button', { type: 'button', class: 'primary' }, 'Save')
  // The name of an existing playbook is fixed: rules name it, and a rename would leave them without one.
  const name = el('input', { type: 'text', maxlength: 64, spellcheck: 'false', disabled: !p.isNew })
  name.value = p.name
  const body = el('textarea', { class: 'md', rows: 20, spellcheck: 'false' })
  body.value = p.body
  let touchedName = !p.isNew
  const check = () => {
    const e = playbookErrors(p, state)
    nameErr.textContent = touchedName ? e.name || '' : ''
    bodyErr.textContent = e.body || ''
    size.textContent = sizeText(p.body)
    save.disabled = Boolean(e.name || e.body) || p.sending
  }
  name.addEventListener('input', () => {
    p.name = name.value.trim()
    touchedName = true
    check()
  })
  body.addEventListener('input', () => {
    p.body = body.value
    check()
  })
  const row = playbookRows(state, p.level).find((r) => r.name === p.name) || { name: p.name, usedBy: [], used: 'not used by a rule' }
  page.append(el('div', { class: 'card' },
    el('div', { class: 'field' }, el('div', { class: 'lbl' }, el('span', { text: 'Name' }), el('small', { text: 'playbooks/<name>.md: letters, digits, "_" or "-"' }), nameErr), el('div', { class: 'ctl' }, name)),
    el('div', { class: 'field col' }, el('div', { class: 'lbl' }, el('span', { text: 'Markdown' }), el('small', { text: 'what the session checks, how, and what it reports; front matter "model: sonnet" is optional' })), body, bodyErr, size),
    p.isNew ? null : el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: row.used }))))

  save.addEventListener('click', () => {
    p.sending = true
    check()
    request('savePlaybook', { level: p.level, name: p.name, body: p.body, create: p.isNew, hash: p.hash }, (res) => {
      p.sending = false
      if (res.ok) {
        ui.pb = null
        ui.formMsg = null
        showNotice(`Saved playbook ${res.name}.`, 'info')
        return
      }
      if (res.stale) {
        p.hash = res.hash === undefined ? null : res.hash
        showNotice(`${res.error}: the file was changed outside the panel. Your text is kept; Save again writes it over the new version, Cancel drops it.`)
      } else showNotice(res.error)
      check()
    })
  })
  const del = el('span', { class: 'confirm' })
  const drawDelete = () => {
    del.textContent = ''
    if (p.isNew) return
    if (!p.confirm) {
      del.append(button('Delete', () => { p.confirm = true; drawDelete() }, 'Delete this playbook', 'danger'))
      return
    }
    const blocked = deleteBlocked(row)
    if (blocked) {
      del.append(el('span', { class: 'problem', text: blocked }), button('OK', () => { p.confirm = false; drawDelete() }))
      return
    }
    del.append(el('span', { text: confirmText('playbook', p.name) }),
      button('Delete', () => request('deletePlaybook', { level: p.level, name: p.name }, (res) => {
        if (res.ok) {
          ui.pb = null
          ui.formMsg = null
          showNotice(`Deleted playbook ${p.name}.`, 'info')
        } else showNotice(res.error)
      }), 'Delete the file', 'danger'),
      button('Cancel', () => { p.confirm = false; drawDelete() }))
  }
  drawDelete()
  page.append(el('div', { class: 'bar form-bar' }, save, button('Cancel', () => { ui.pb = null; ui.formMsg = null; render() }), del))
  check()
  return page
}

// ---- Running ----

/** The tabs Autopilot opened and what waits for a slot (the host's `running` and `queued`). */
function runningTab() {
  const m = runningModel(state, Date.now())
  const out = el('div', {})
  if (m.slots) out.append(el('div', { class: 'bar' }, el('span', { class: 'muted', text: m.slots })))
  if (m.empty) {
    out.append(el('div', { class: 'card' }, el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: m.empty }))))
    return out
  }
  if (m.rows.length) {
    const card = el('div', { class: 'card' })
    for (const r of m.rows) {
      const lbl = el('div', { class: 'lbl' }, el('span', { class: 'title', text: r.title, title: r.title }), el('small', { text: [r.meta, r.since, r.updates].filter(Boolean).join(' · ') }))
      if (r.flags.length) lbl.append(el('div', { class: 'warn', text: r.flags.join(' · ') }))
      card.append(el('div', { class: 'field' }, lbl, el('div', { class: 'ctl mark no', text: r.status })))
    }
    out.append(card)
  }
  if (m.queue.length) {
    out.append(el('h3', { text: `Queue (${m.queue.length})` }))
    const card = el('div', { class: 'card' })
    for (const q of m.queue) card.append(el('div', { class: 'field' }, el('div', { class: 'lbl' }, el('span', { class: 'title', text: q.title, title: q.title }), el('small', { text: [q.meta, q.since].filter(Boolean).join(' · ') }))))
    out.append(card)
  }
  return out
}

// ---- Log ----

function logCard() {
  const entries = state.log || []
  if (!entries.length) return el('div', { class: 'card' }, el('div', { class: 'field' }, el('div', { class: 'lbl muted', text: 'Nothing has run yet.' })))
  const card = el('div', { class: 'card log' })
  const now = Date.now()
  for (const e of entries.slice(0, 100)) {
    const m = logModel(e, now)
    card.append(el('div', { class: `field ${m.kind}` },
      el('span', { class: 'when', text: m.when }),
      el('div', { class: 'lbl' }, el('span', { class: 'title', text: m.title, title: m.title }), m.meta ? el('small', { text: m.meta }) : null, m.outcome ? el('small', { class: 'outcome', text: m.outcome }) : null)))
  }
  return card
}

// ---- the page ----

function render() {
  const r = root()
  r.textContent = ''
  if (!state) {
    r.append(el('div', { class: 'empty', text: 'Loading…' }))
    return
  }
  if (state.fatal) {
    r.append(el('div', { class: 'notice error', text: state.fatal }))
    return
  }
  const page = el('div', { class: 'set' })
  if (ui.form || ui.pb) {
    page.append(ui.form ? ruleFormView() : playbookView())
    r.append(page)
    return
  }
  ui.formMsg = null
  if (ui.notice) page.append(el('div', { class: `notice ${ui.noticeKind}`, text: ui.notice }))
  page.append(switchCard())
  const problems = problemLines(state)
  if (problems.length) {
    page.append(el('h3', { text: `Problems (${problems.length})` }))
    for (const p of problems) page.append(el('div', { class: 'src-err', text: p }))
  }
  // A v1 rules.json that is not read: a plain note, never a problem.
  for (const h of hintLines(state)) page.append(el('div', { class: 'notice info', text: h }))
  for (const lv of levelsOf(state)) {
    const folder = folderCard(lv)
    if (folder) page.append(el('h3', { text: `${lv.label} rules folder` }), folder)
  }
  page.append(tabBar())
  if (ui.tab === 'playbooks') page.append(playbooksTab())
  else if (ui.tab === 'running') page.append(runningTab())
  else if (ui.tab === 'log') page.append(logCard())
  else page.append(rulesTab())
  r.append(page)
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'state') {
    state = m
    ui.busy = null
    // An open form is never redrawn under the person's typing: it uses the new state on its next
    // check, and the page shows it when the form closes.
    if (!formOpen()) gate.request()
  } else if (m.type === 'result') {
    const done = pending.get(m.req)
    pending.delete(m.req)
    ui.busy = null
    if (done) done(m)
    else if (!formOpen()) gate.request()
  } else if (m.type === 'notice' && typeof m.text === 'string') {
    ui.busy = null
    showNotice(m.text)
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') post('visible')
})
window.addEventListener('focus', () => post('visible'))
// The log's times say "14:05" today and a date before: redraw now and then for the day change.
setInterval(() => {
  if (state && ui.busy === null && !formOpen()) gate.request()
}, 60000)

post('hello')
