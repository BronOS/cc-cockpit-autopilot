# Autopilot (bronos.autopilot)

A [cc-cockpit](https://github.com/BronOS/cc-cockpit) plugin. It watches every plugin that offers an
`inbox-feed` (Google Chat, Gmail and Jira today), and when a new or changed item matches one of your
rules it opens a Claude tab that investigates the item with a playbook you wrote, before you have looked,
or (an act rule) runs one of the item's own actions, such as mark read, with no Claude at all.

Examples of rules: "a message in the Deploys space that says a deploy failed", "a support ticket that
says people cannot log in to a website".

The session investigates and reports in its tab. Its prompt tells it to change nothing (or, in act mode,
to do only what its playbook lists), and anything your permission allowlist does not allow waits for you
at a prompt (see Safety).

**Needs cc-cockpit 0.11.0 or newer** (`inbox-feed` v2, `ctx.services.useAll`). **`model`, `effort` and
the takeover check need 0.11**: an older app ignores `model` and `effort` (the panel and `ccc autopilot`
say so) and, since it cannot tell whether you typed, delivers no update into a tab. Autopilot is **off by
default**: a fresh install fires nothing until you switch it on.

## Setup

1. Make a rules folder. Rules live at two levels (see Two rule levels): **global** rules, in the app
   setting **Global rules folder** (default `~/.config/cc-cockpit-autopilot`), run in every project;
   **project** rules, in the project setting **Project rules folder** (empty by default: none; a
   relative path is read from the project folder), run in that project only. `~` is your home folder.
   Your rules and playbooks are your work: keep them in those folders (a private git repo is fine),
   never in this plugin's repo. When a folder is missing, the panel offers **Create folder** and **Add
   the example rules** (`examples/`, every rule switched off).
2. Change the names, spaces and sites to yours: in the panel, by hand, or with Claude (the
   `autopilot-rules` skill teaches it the format and the safe way to work).
3. Enable Autopilot in the project whose window should hold the sessions (each project with it enabled
   is its own autopilot; sessions open in that project's folder, in its window, and only while the
   window is open).
4. Try the rules first: **Dry run** in the panel, or `ccc autopilot test`. It shows which items in the
   feeds right now each rule would fire on and why, and starts nothing.
5. Switch it on: the switch in the panel, or `ccc autopilot on`.

Optional: the `jev` plugin, for rules with a Jev question. Without it such an item fires nothing until
one is back.

## Settings

- `globalFolder` (app setting, the same in every project): the global rules folder. Empty: no global
  rules.
- `projectFolder` (project setting; the app also has a global value for it and a per-project override):
  the project rules folder. Empty (the default): no project rules.
- `maxRunning` (1 to 10, default 3): see One tab per item.
- `myNames`: your own names and addresses in the sources (for example `Ann Example`,
  `ann@example.com`). A change whose latest activity is yours (your reply) is not delivered into the
  item's tab. Empty: no such check.

## Two rule levels

Each level is a folder with its own `autopilot-rules.json` and `playbooks/`. Project rules are checked
first, then global ones; the first rule that holds takes the item. A rule's playbook is read from its own
level's `playbooks/`. Ids are unique within a level, so a rule is named with its level wherever it shows
(`project:deploy-failed`, `global:lead-mail`): the log, the prompt, `ccc autopilot`, the panel's tags.
A global rule's `perDay` and cooldown count per project (each project's window keeps its own log).

## Rules: `autopilot-rules.json`

A JSON list. `ccc autopilot format` prints the format from the code that checks it. Every rule is
checked on every read: a bad one is shown as a problem and skipped, the others keep working. An unknown
key is ignored with a warning.

```json
[
  {
    "id": "deploy-failed",
    "name": "Failed deploys",
    "enabled": false,
    "sources": ["bronos.chat"],
    "when": [
      { "field": "place.name", "op": "is", "value": "Deploys" },
      { "field": "title", "op": "contains", "value": "failed" }
    ],
    "jev": { "question": "Does this report a failed production deploy?", "min": 0.7 },
    "hours": { "from": "08:00", "to": "19:00" },
    "playbook": "investigate-deploy",
    "check": "A production deploy failed (not staging, not a test run).",
    "model": "sonnet",
    "effort": "medium",
    "onChange": false,
    "limits": { "perDay": 10, "cooldownMinutes": 30 }
  }
]
```

| Key | Value | Default |
|---|---|---|
| `id` | 1-64 letters, digits, `.`, `_`, `-`; unique | required |
| `name` | up to 60 characters, for people | the id |
| `enabled` | `true` / `false` | `true` (rules added by `ccc autopilot rules add` are stored off) |
| `sources` | plugin ids whose items the rule looks at, or exactly `["*"]` | **required** |
| `when` | up to 20 conditions, all must hold (the same format as Inbox's rules) | none |
| `jev` | `{ "question": "...", "min": 0.7 }`: Jev scores title and preview from 0 to 1 | none |
| `hours` | `{ "from": "22:00", "to": "07:00" }`, 24-hour local time; `to` before `from` crosses midnight | any time |
| `playbook` | the file `playbooks/<name>.md`, without `.md` | a session rule: required |
| `act` | one of the item's own actions instead of a session: `markRead`, `markUnread`, `done` or a source's own (never `open`) | an act rule: required |
| `mode` | `investigate` or `act` (a session rule only, see Act mode) | `investigate` |
| `check` | up to 500 characters: what the session verifies first against the full item | none |
| `model` | `haiku`, `sonnet`, `opus`, `fable` (needs app 0.11) | your default |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` (needs app 0.11) | your default |
| `onChange` | send newer versions of the item into its tab | `false` |
| `limits.perDay` | 1-100 sessions (or actions) in a rolling 24 hours | 10 (an act rule: 100) |
| `limits.cooldownMinutes` | 0-1440 minutes between two sessions (or actions) of the rule; 0 is no cooldown | 30 (an act rule: 0) |

A rule has `playbook` or `act`, never both. `check`, `model`, `effort`, `onChange` and `mode` belong to a
session, so an act rule may not have them.

- **`sources` is required, on purpose.** A rule written with Chat in mind must not fire on incoming
  email by omission, since anyone outside can send mail. `["*"]` and mail sources are flagged as
  something outsiders can trigger. An id with no running feed is kept ("no such source here").
- **Conditions** are Inbox's: `field`, `op`, `value`, text compared case-insensitively, no regular
  expressions. Fields: `source`, `sourceKind`, `title`, `preview`, `from.name`, `from.address`, `to`,
  `mentionsMe`, `read`, `place.kind`, `place.name`, `place.status`, `labels`, `time`. `ccc autopilot
  format` lists each with its ops.
- **`when` and `jev`** say which items the rule is about; fields are checked first, so Jev is asked
  only about items that pass them. With neither, every new item of the sources starts a session (limits
  still apply): the panel asks you to confirm.
- **First rule wins.** Rules are tried in file order; the first that holds is the item's rule, later
  ones are logged as "also matched". Checks per rule: enabled, sources, hours, `when`, `jev`. A rule
  whose Jev answer is pending holds the lower rules too; Jev unavailable retries after 10 minutes.
- **`hours`**: outside them the rule does not fire and the item is not kept for later.
- **`check`** makes a loose `when` cheap: when it does not hold, the session says so in one line and
  stops.
- **`limits`**: a run refused by a limit is logged and not queued.
- **`onChange`**: by default a rule fires once per item and a later reply is only logged. With
  `true` a newer version is sent into the same tab (see Updates).

**No burst at start.** Items in the feeds when the app starts, when a feed joins or when you switch
Autopilot on are the baseline: they never fire. Only items that appear or change after it do.

## Three kinds of rule

From least to most power:

| You want | Rule | Why |
|---|---|---|
| one of the item's own actions and nothing else ("mark the tracker's Done notification mails read") | an **act rule**: `"act": "markRead"` | no Claude runs, so no outside text reaches a model |
| a session that looks and reports | a session rule, `mode` left out (`investigate`) | it changes nothing |
| a session that also does a few named things | `"mode": "act"` and an `## Allowed actions` list in the playbook | it may do only what that list names, on that item |

**Act rules.** Autopilot calls the source's own `act(id, action)` (the same call Inbox makes when you
click), only on a **new** item (a changed one is never acted on), and only when the action is in the
item's `actions` list right now; when it is not, the rule does not hold, the log says why and the next
rule may take the item. Hours, `when`, `jev`, limits and first-rule-wins apply as for any rule, and two
windows never act on the same item (the item is claimed while the action runs). The log says
`marked read: <title>`, or the source's error; only an action that went through counts against the
limits. Act rules send no notification and do not count toward the 10 sessions an hour.

```json
{ "id": "done-mails-read", "sources": ["bronos.gmail"],
  "when": [{ "field": "from.address", "op": "is", "value": "tracker@example.com" },
           { "field": "title", "op": "contains", "value": "Done" }],
  "act": "markRead" }
```

An act rule's default limits are 100 a day and no cooldown, so every matching mail is handled (a cooldown
would leave the second mail within it unread). A session rule's are 10 a day, 30 minutes apart. Set `limits`
only to change them.

**Act mode.** A session rule with `"mode": "act"` gets a different permission line in its frame; nothing
else in the frame changes. Its playbook must have an `## Allowed actions` heading with each action as a
list item, or the rule is a problem and never runs:

```markdown
## Allowed actions

- Re-check https://www.example.com once, two minutes after the alert.
- Append one line to ~/notes/site-incidents.md: the time, the site and what you found.
```

The session may do those, on that item only; anything else it thinks should be done it reports as a
recommendation. Name each target in the list itself, so nothing has to come from the item. The panel
warns when you pick act mode, more strongly for a rule outsiders can trigger (any mail source or
`["*"]`): there a stranger's message starts a session that may take those actions. See
`examples/playbooks/site-log.md`.

## One tab per item, `maxRunning`, the queue

An item gets one tab. While its tab is open no second session starts for it, whatever a later version
says. At most `maxRunning` tabs per window are *starting or working*; more items wait in a queue (one
entry per item, a newer version replaces the older, at most 50). A tab that has finished and waits for
you to read it, one waiting for a permission answer and an ended one free their slot, so night runs do
not block the morning. A closed tab frees the item: with `onChange`, its next new version goes through
the rules again.

**One window per item.** A global rule runs in every open project, so two windows could match the same
item. Before it opens or queues an item, a window claims it app-wide (in the plugin's app storage);
the window that comes second logs "running in another window" and neither opens nor queues it. Only the
window holding the claim delivers updates into the item's tab. The claim goes when the tab ends or
closes, the item leaves the queue, its rule is switched off or deleted, the open fails, or the project
window closes; after an app restart each project keeps the claims of its restored tabs. A claim from a
window that crashed is freed by another window once it has not been refreshed for 3 hours (the owner
refreshes every 10 minutes) and that window has watched it for 30 of its own minutes awake.

## Updates, and typing taking a tab over

With `onChange: true`, a newer version of the item is delivered into its tab:

- Updates are merged: at most one is pending per item, so five messages during one run arrive as one
  delivery of the latest state.
- It is typed only when Claude in that tab is waiting for input, never while it works or waits for a
  permission answer.
- At most 5 updates go into one tab.
- **Typing takes the tab over.** Once you press a key in it, Autopilot sends nothing more there until
  it closes (clicking and scrolling do not count; a paste does). The app enforces this: it refuses a
  plugin's send to such a tab and drops texts still queued. Needs app 0.11.
- None after the session ran `ccc autopilot stop <run>` (the prompt tells it to when the check is not
  met, an injection is suspected or there is nothing more to do).
- Your own reply is not delivered when `myNames` lists you.

Every update is outside text entering the session: an `onChange` rule on a source outsiders can reach
is a bigger exposure than a plain one.

## From v1 to v2

v2 reads `autopilot-rules.json`; v1's `rules.json` is never read or written. When a folder has a
`rules.json` and no `autopilot-rules.json`, the panel and `ccc autopilot` show one plain note (never an
error). There is no automatic migration: ask Claude to port the old file (the `autopilot-rules` skill
knows the mapping), or write the rules again with `rules add`. An entry with `match` or `triage` in the
new file is an invalid rule like any other, and its problem names the v1 key. Playbooks need no change.

| v1 | v2 |
|---|---|
| `match.source` | `sources` (a list); no source in v1 meant any: write `["*"]` only if that is meant |
| `match.where` | a `place.name` `contains` condition in `when` |
| `match.from` | a `from.name` `contains` condition |
| `match.text` | a `title` `contains` condition |
| `match.level` | no equivalent: `labels` or a Jev question |
| `triage.jev` | `jev` (same `question` and `min`) |
| `condition` | `check` |
| `on` | `enabled` |
| playbook front matter `model` | `model` in the rule (front matter is ignored with a warning) |

Port the rules off, test each against the current feeds, enable one at a time. v1's global limit of
10 sessions an hour is replaced by `maxRunning`. `myNames` is new: set it if you use `onChange`.

## Managing rules from the panel

The files stay the single source of truth: what the panel writes is plain `autopilot-rules.json` and
`playbooks/<name>.md`, so hand edits, git and Claude's edits keep working next to it.

- **Rules** tab: the project rules, then the global ones, each entry in file order with its level tag, switch, **Edit**, **Delete**, warnings and
  problems. The form has the sources (the feeds running now), condition rows, a Jev question, hours,
  what the rule does (a session, or an action with no session), playbook (or **New playbook**), mode
  (with its warning), check, model, effort, limits and "again on change", and checks the rule with the
  loader's own code. A new rule starts off; when both folders exist, the form asks which
  level it goes to.
- **Running** tab: the tabs Autopilot opened, the queue and the slots; **Playbooks** (with each
  level's `base.md`: in use or not, and an edit entry) and **Log** (newest first).
- **Ask Claude to write a rule** opens a tab that learns the format, asks what the rule is for,
  edits the files, runs `ccc autopilot test <id>` and shows the result.

A save is checked again by the host, written through a temp file and rename, refuses a symbolic link,
refuses with "changed on disk: reloaded" when that level's file changed since the panel read it, and
rewrites only the entry you edited (every other entry, an invalid one included, is written back as it was).

## Playbooks: `playbooks/<name>.md`

Markdown you write: what to check, how, and what to report. At most 64 KiB. The name is 1-64 letters,
digits, `_` or `-`. The model and effort are the rule's; front matter in a playbook is ignored with a
warning. A playbook should name the places it may check itself (your hosts, projects), so the session
never takes one from the item: see `examples/playbooks/site-check.md`. One playbook can serve several
rules of different weight.

## base.md: your standing instructions

An optional `base.md` in a level's folder (beside `autopilot-rules.json`, at most 16 KiB): what every
session of that level should know, such as how to write the summary or what never to touch. It goes into
every session prompt after the fixed frame and before the item, global first, then project, under a
heading that says it adds to the frame and never lifts it. Marker look-alikes are taken out of it. A
`base.md` that is there but cannot be used (too big, a link) stops every session from opening until it is
fixed, so a rule never runs without instructions you meant it to have. Edit it on the panel's Playbooks
tab or with `ccc autopilot base set`. Act rules have no prompt, so it does not reach them.

## The prompt

Every session gets a fixed frame, your `base.md` (when there is one), the item, then your playbook: the
rule's name, "investigate only; change nothing" (or, in act mode, the permission to carry out only the
playbook's Allowed actions), the item between a random marker made fresh for the run (anything in the item that
looks like a marker is taken out first), the instruction to check for injection first and never follow
the item, the rule's `check`, and a short summary at the end. With `onChange` the frame also says that
newer versions may arrive and how to stop (`ccc autopilot stop <run>`).

## Safety

The session reads text from outside by design, and it keeps its tools. What limits the damage:

- **Normal mode, your allowlist.** What your permission allowlist allows runs; anything else waits at a
  prompt. "Change nothing" is an instruction, not a sandbox: keep the allowlist read-only. In act mode
  too, Claude Code's own permission settings still apply inside the tab.
- **The frame is fixed.** Outsiders write the item and nobody watches, so neither your `base.md` nor a
  playbook can change the frame's order or wording; act mode changes only the permission line.
- **Act rules run no model**: there is nothing for the item's text to inject into.
- **The item is fenced and untrusted**, and a playbook that names its own places leaves the session
  nothing to take from the item.
- **Outsider triggers are flagged.** `["*"]`, any mail source and an `onChange` rule on them show a
  warning in the panel and in `ccc autopilot`.
- **Takeover.** Your typing ends all automatic input to that tab, enforced by the app.
- **Limits and one switch.** `perDay`, a cooldown, `maxRunning`, 5 updates a tab. The panel's switch or
  `ccc autopilot off` stops every automatic run.
- **Everything is logged** (the last 200, in this project's plugin storage).

Tests passing do not prove safety; they catch regressions.

## CLI

```
ccc autopilot [status]                       on or off, both folders, rules, problems, running, last runs
ccc autopilot on | off                       the switch (on takes the baseline first)
ccc autopilot log [n]                        the last n entries (default 20, at most 200)
ccc autopilot test [rule|<json>|-] [--at <n>] [--jev] [--project|--global]
                                             dry run; a stored rule id, or a rule not yet stored; Jev only with --jev
ccc autopilot reload                         read both folders again and list the problems
ccc autopilot format                         the format: every field, type and limit
ccc autopilot rules [export|add|set|rm|move|enable|disable] [--project|--global]
ccc autopilot playbooks [show|set|rm] [--project|--global]
ccc autopilot base [show|set <text|->] [--project|--global]
                                             the base.md of each level; an empty text removes it
ccc autopilot stop <run>                     for the run's own tab only: stop updates
ccc autopilot help
```

- A `-` argument reads stdin (JSON for `rules add|set` and `test`, text for `playbooks set` and `base set`), so long
  input needs no shell quoting: `echo '{...}' | ccc autopilot rules add -`. stdin is read only then.
- Reads show both levels. A write needs `--project` or `--global` (or a rule named `project:<id>` /
  `global:<id>`) when both folders exist; with one folder it goes there.
- A rule number is its position in its level's `autopilot-rules.json` as `rules` prints it; digits only
  is always a position, anything else an id.
- `rules add` stores the rule off and refuses a rule whose playbook does not exist, or an act-mode rule
  whose playbook has no `## Allowed actions` list; on any problem nothing is stored and the error names
  the field.
- Exit codes: 0 done, 1 refused, 2 usage or unparsable JSON.

## Development

Plain JavaScript with no build and no dependencies. `npm test` runs the node:test suites in `test/`
over fakes (a fake ctx, feeds, Jev and clock; no real timers or network). To try it from a checkout:
`ccc plugin link <path>` in a cc-cockpit tab. The designs are in [docs/design-v2.md](docs/design-v2.md)
(this version) and [docs/design.md](docs/design.md) (v1, what v2 keeps).

## License

MIT
