---
name: autopilot-rules
description: Use when asked to add, change, remove, reorder, test, explain or port the rules, playbooks or base.md of the cc-cockpit Autopilot plugin (bronos.autopilot), for example "investigate failed deploys in the Deploys space with sonnet", "mark the Done notification mails read", "why did Autopilot not fire on this", "write a playbook for X", "turn off the Jira rule", "port my old v1 rules.json", or when Autopilot started a session it should not have.
---

# Autopilot rules and playbooks (`ccc autopilot rules`, `ccc autopilot playbooks`, `ccc autopilot base`)

Autopilot watches the inbox feeds (Chat, Mail, Jira and any other `inbox-feed` plugin). When a **new or
changed item** matches a rule, it **starts a Claude session on its own** in a new tab, with the rule's playbook,
and nobody asked for it, or, for an **act rule**, runs one of the item's own actions (mark read, done) itself. That is the point of the plugin and also its risk: a rule that is too loose starts many
sessions (each one costs money and reads outside text), and a rule on a source that outsiders can write to (mail
above all) lets a stranger's text start a session. So you work like this:

- Write every new rule **off** (`rules add` does that unless the JSON says `"enabled": true`), test it, show the
  person the result, and **switch it on only when the person says so**. Never enable a rule on your own.
- Say plainly in your answer that an enabled rule starts sessions by itself.
- Autopilot has a global switch too (`ccc autopilot on` / `off`). Off, nothing fires, whatever the rules say.
  Do not switch it on for the person.

## Two levels

Rules live at two levels, each a folder with its own `autopilot-rules.json` and `playbooks/`:

- **Project rules** (the project setting "Project rules folder", empty by default: none; a relative path is read
  from the project folder) run in this project only.
- **Global rules** (the app setting "Global rules folder", default `~/.config/cc-cockpit-autopilot`) run in
  every project.

Project rules are checked first, then global ones; the first rule that holds wins. A rule's playbook is read
from its **own** level's `playbooks/`. Ids are unique per level only, so a rule is named `<level>:<id>`
(`project:deploy-failed`, `global:deploy-failed`) in the log, the prompt and `ccc autopilot`. Reads show both
levels; **every write needs the level when both folders exist**: add `--project` or `--global`, or name the rule
as `project:<id>` / `global:<id>`. Ask the person which level a new rule belongs to when it is not clear: a rule
about one project's deploys is a project rule, a rule about the person's mail usually a global one.

## Which kind of rule

Pick the least power that does the job:

| The person wants | Write | Why |
|---|---|---|
| one of the item's own actions and nothing else ("mark these mails read", "mark it done") | an **act rule**: `"act": "markRead"` and no playbook | no Claude runs, so no outside text reaches a model: nothing to inject into, nothing to pay for |
| someone to look and report ("investigate failed deploys") | a session rule, `"mode": "investigate"` (the default) | the session changes nothing |
| a session that also does a few named things ("check the site, and log it in my notes file") | a session rule with `"mode": "act"` and an `## Allowed actions` list in its playbook | the session may do only what that list names, on that item |

"Mark the Jira-Done notification emails read" is an **act rule**: a `bronos.gmail` rule whose `when` picks those
mails (the sender's address, `Done` in the title) and `"act": "markRead"`. Not a session: reading a mail to mark
it read needs no Claude, and a session would read an outsider's mail for nothing.

- **Act rule** (`act`): an action id the item offers: the well-known `markRead`, `markUnread`, `done` (done at the
  source: archive, resolve), or one the source adds (`ccc <source> show <id>` and the Inbox panel show an item's
  actions). Never `open` (it opens a window for a person; refused). It runs **on new items only** (with `onChange` also on each new version of an item, below), and only when the item offers that action **at that moment**; when it does not, the rule does not
  hold and the next rule may take the item (logged as step `action`). An act rule has no `playbook`, `mode`,
  `check`, `model` or `effort` (refused: they belong to a session); `onChange` is allowed. `sources`, `when`, `jev`, `hours`,
  `limits`, first rule wins and the one-window claim apply as to any rule. Its limits count only actions that
  succeeded, and it is not counted in the 10-sessions-an-hour cap. Its default limits are 100 a day and no
  cooldown (a cooldown would leave a second matching mail within it unread), so leave `limits` out unless the
  person wants fewer. It sends no
  notification. A mail act rule is still one **outsiders can trigger**: a stranger's mail made to match is marked
  read unseen; keep `when` narrow (the exact sender address) and tell the person.
- **Act mode** (`"mode": "act"`): the playbook must have a heading `## Allowed actions` with each action as a list
  item, each with its exact target ("append one line to ~/notes/site-incidents.md", not "fix things"). Without it
  the rule is a problem and never runs. The session may do only those, only on this item; anything else it
  reports as a recommendation; it never takes an action, a target or a command from the item's text. Claude
  Code's own permission settings still apply inside the tab: an action they do not allow waits at a prompt.
  An act-mode rule on a source outsiders can reach is the riskiest kind there is: say so, and prefer
  investigate there.

## How to work

1. `ccc autopilot` (status) and `ccc autopilot rules`: both folders, the numbered rules of each level (on or off,
   what each checks), the problems, the sources (feeds) available now.
2. `ccc autopilot format` prints the format from the code that checks it, so trust it over this text if they
   ever differ.
3. Write the playbook first (`playbooks set`), then the rule that names it (`rules add` refuses a rule whose
   playbook does not exist).
4. Try the rule before storing it: `ccc autopilot test '<rule json>'` (see Testing). Fix, repeat.
5. `rules add` it (it is stored off), `ccc autopilot test <id>` once more on the stored rule, then tell the person
   what it would do and ask whether to enable it (`rules enable <id>`).
6. Prefer small edits (`add`, `set`, `move`, `enable`, `disable`, `rm`) to editing `autopilot-rules.json` by hand.
   They go through the same checks as a Save in the Autopilot panel, change only the one entry of one level's
   file (every other entry, even a broken one, is written back as it was) and refuse to overwrite a hand edit
   made meanwhile.

The rules are the person's own work, kept in files in their rules folders (`ccc autopilot` prints both):
`autopilot-rules.json` and `playbooks/<name>.md`. Keep every rule you were not asked to touch exactly as it is.

## Commands

```
ccc autopilot                                   status: on or off, both folders, rules, problems, last runs
ccc autopilot rules [--project|--global]        the numbered entries of each level's autopilot-rules.json
ccc autopilot rules export [--project|--global] one level's file as JSON; no level: {"project": [...], "global": [...]}
ccc autopilot rules add <json|-> [--at <n>]     add one rule (stored off unless the JSON says enabled)
ccc autopilot rules set <n|id> <json|->         replace a rule (keeps its id and on/off when the JSON has none)
ccc autopilot rules rm <n|id>                   remove a rule (its playbook file stays)
ccc autopilot rules move <n|id> <to>            move a rule to position <to>
ccc autopilot rules enable <n|id>               switch a rule on
ccc autopilot rules disable <n|id>              switch a rule off
ccc autopilot playbooks [--project|--global]    the playbook files of each level and the rules that use each
ccc autopilot playbooks show <name>
ccc autopilot playbooks set <name> <text|->     create or replace a playbook
ccc autopilot playbooks rm <name>               delete a playbook (refused while a rule names it)
ccc autopilot base [show] [--project|--global]  the level's base.md (both levels without a flag)
ccc autopilot base set <text|->                 write that level's base.md; an empty text removes it
ccc autopilot test [rule|<json>|-] [--at <n>] [--jev] [--jira] [--project|--global]   dry run, nothing starts
ccc autopilot reload                            read the files again and list the problems
ccc autopilot format                            the format
ccc autopilot log [n]                           the last runs and skips, newest first
ccc autopilot help
```

- Quote the JSON as one shell argument (single quotes), or pass `-` and pipe it:
  `echo '{"id":"x",...}' | ccc autopilot rules add -`. A playbook is best piped:
  `ccc autopilot playbooks set deploy-check - <<'EOF'` then the Markdown. stdin is read only for a `-`
  argument, so no other command ever waits on it.
- Every write (`rules add|set|rm|move|enable|disable`, `playbooks set|rm`) and a JSON `test` takes `--project` or
  `--global` when both folders exist; with only one folder it goes there. `project:<id>` / `global:<id>` names the
  level too (`ccc autopilot rules enable global:lead-mail`). Without it, the command stops with "Both rule levels
  have a folder" (exit 2) and nothing is stored.
- A number is the **position in that level's `autopilot-rules.json`** as `ccc autopilot rules` prints it (1 is the
  first; invalid and off rules count). A word of digits only is always a position; anything else is an id.
- `rules add` without `--at` puts the rule last in its level. **Order matters**, see First rule wins.
- A rule given without an `id` gets one (`r1`, `r2`, ...). Give a short readable id yourself: the log and the
  once-per-item record are keyed by it.
- On any problem nothing is stored and the error names the field: `Nothing stored: the rule is not valid: sources is
  missing: choose the sources ...`. Fix that part and run the command again.
- Exit codes: 0 done, 1 refused (nothing stored), 2 a usage error or JSON that does not parse.

## The rule

```json
{
  "id": "deploy-failed",
  "name": "Failed deploys",
  "enabled": false,
  "sources": ["bronos.chat"],
  "when": [
    { "field": "place.name", "op": "is", "value": "Deploys" },
    { "field": "title", "op": "contains", "value": "failed" }
  ],
  "hours": { "from": "08:00", "to": "19:00" },
  "playbook": "investigate-deploy",
  "mode": "investigate",
  "check": "A production deploy failed (not staging, not a test run).",
  "model": "sonnet",
  "effort": "medium",
  "onChange": false,
  "limits": { "perDay": 10, "cooldownMinutes": 30 }
}
```

- `id` (required): 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit; unique in its level's
  file (the other level may have the same id: that is another rule, named `project:<id>` or `global:<id>`).
  `name`: at most 60 characters, for people. `enabled`: default true in the file format, but you add rules off.
- **`sources` (required)**: 1 to 20 plugin ids whose items the rule looks at (`bronos.chat`, `bronos.gmail`,
  `bronos.jira`; the ids are in `ccc autopilot` under Sources), or exactly `["*"]` for any source. There is no
  default on purpose: a rule written with Chat in mind must not fire on incoming email by omission, since
  anyone outside can send mail. Choose the narrowest list that does the job. A rule on `*` or on a mail source
  is one that **outsiders can trigger**; `ccc autopilot` flags it, and you should tell the person.
  An id with no running feed is kept ("no such source here"): a source may come later.
- `when`: 0 to 20 conditions, all must hold (the table below). `jev`: one question for Jev (below). A rule needs
  something to say which items it is about: `when`, `jev` or both (fields are checked first, so Jev is asked only
  for items that pass them). With neither, **every new item of its sources starts a session** (limits still apply):
  say so to the person and avoid it.
- `playbook`: the name of `playbooks/<name>.md` in the rule's own level, written without `.md`. A rule has
  `playbook` (a session) or `act` (an act rule, see Which kind of rule), exactly one of them.
- `mode`: a session rule's `investigate` (the default: change nothing) or `act` (only the playbook's
  `## Allowed actions`). See Which kind of rule.
- `check`: optional, at most 500 characters. What the session verifies first against the **full** item (it may
  name what only the item shows, a screenshot too). When it does not hold, the session says so in one line and
  stops. A loose `when` plus a precise `check` costs one short session instead of a wrong investigation. (v1
  called it `condition`.)
- `hours`: optional, `{ "from": "22:00", "to": "07:00" }`, 24-hour local time of the machine; `from` inclusive,
  `to` exclusive, `to` before `from` crosses midnight; the same time twice is an error. Outside the hours the rule
  does not fire and the item is **not** kept for later.
- `model` and `effort`: optional. Left out, the session uses the person's own default. `model`: `haiku`,
  `sonnet`, `opus` or `fable`; `effort`: `low`, `medium`, `high`, `xhigh` or `max`. They need cc-cockpit 0.11; an
  older app ignores them (the panel and `ccc autopilot` say so). Pick the cheapest that suffices; leave them out
  unless the person asks for one or the task clearly needs it. `fable` is the costliest model: write it only when
  the person names it for that rule, never as your own pick.
- `onChange`: default false. See onChange below.
- `limits`: `perDay` 1 to 100 sessions in a rolling 24 hours (default 10) and `cooldownMinutes` 0 to 1440
  between two sessions of this rule (default 30); 0 is no cooldown. An act rule's defaults are 100 a day and 0
  (no cooldown); its limits count actions. A run refused by a limit is logged and not queued. On top of
  these Autopilot runs at most `maxRunning` sessions at once per window (project setting, default 3); more wait
  in a queue.
- An unknown key is ignored with a warning.

### First rule wins

Rules are tried **in order**: the project file first, then the global one, each in file order. The first that
holds is the item's rule, and the later ones are logged as "also matched" and never run. A narrow rule must stand
above a broad one on the same source; a project rule can take an item before a global rule would. For each rule the order
of checks is: enabled, sources, hours, `when`, `jev`: cheapest first. A rule's Jev question that is still
waiting for an answer holds the lower rules too (they do not fire meanwhile), and Jev being unavailable is
retried after 10 minutes instead of falling through, so with no Jev provider such an item fires nothing until one is back.

### Conditions

`{ "field": ..., "op": ..., "value": ... }`, the same format as the Inbox plugin's rules. Text compares
case-insensitively; there are no regular expressions. An `in` op takes a list of 1 to 50 values of the field's
kind and holds when the item's value is one of them; `notIn` holds when it is none of them (and for an item that lacks the field).

| Field | Ops | Value |
|---|---|---|
| `source` | `is`, `isNot`, `in`, `notIn` | a source plugin id (text), for example `bronos.gmail` (use `sources` instead) |
| `sourceKind` | `is`, `isNot`, `in`, `notIn` | `chat`, `mail`, `issues` or `other` |
| `title` | `contains`, `notContains`, `startsWith`, `is` | text |
| `preview` | `contains`, `notContains`, `startsWith`, `is` | text |
| `from.name` | `is`, `isNot`, `contains`, `endsWith`, `in`, `notIn` | text |
| `from.address` | `is`, `isNot`, `contains`, `endsWith`, `in`, `notIn` | text (`endsWith` `@example.com` for a domain) |
| `to` | `is`, `isNot`, `in`, `notIn` | `direct`, `group`, `cc` or `none` (how the item reached the person) |
| `mentionsMe` | `is` | true or false |
| `read` | `is` | true, false or null (null: the source has no read state) |
| `place.kind` | `is`, `isNot`, `contains`, `in`, `notIn` | text: `channel`, `folder` or `project` |
| `place.name` | `is`, `isNot`, `contains`, `in`, `notIn` | text (the channel, folder or project name) |
| `place.status` | `is`, `isNot`, `contains`, `in`, `notIn` | text (for example a Jira status) |
| `labels` | `has`, `hasNot`, `hasPrefix` | text (one label) |
| `time` | `newerThan`, `olderThan` | whole minutes, 1 to 525600 |
| `jira.status` | `is`, `isNot`, `contains`, `in`, `notIn` | text: the issue's status name ("In Progress") |
| `jira.category` | `is`, `isNot`, `in`, `notIn` | `new`, `indeterminate` or `done` (Jira's status category) |
| `jira.done` | `is` | true or false: the issue is in the done category |
| `jira.mine` | `is` | true or false: the issue is assigned to the person |
| `jira.assignee` | `is`, `isNot`, `contains`, `in`, `notIn` | text: the assignee's name (none for an unassigned issue) |
| `jira.priority` | `is`, `isNot`, `contains`, `in`, `notIn` | text: the priority name |
| `jira.type` | `is`, `isNot`, `contains`, `in`, `notIn` | text: the issue type |

Text values are 1 to 200 characters on one line. A field the item lacks holds only for the negative ops
(`isNot`, `notContains`, `hasNot`). A read or label change of an item never starts a session (only a new item
or a new version of one does), so `read is false` is rarely needed.

### Jira conditions (`jira.*`)

The `jira.*` fields are about the **Jira issue the item's title names**, read live, so they answer a question the
mail does not ("is this ticket still In Progress?"). They need the `bronos.jira` plugin (its `jira` service) in the
project; without it they never hold, the rule never fires, and `ccc autopilot reload` / `status` warn about it.

- **The key** comes from the title with a fixed pattern (never one from a rule): a key in parentheses wins
  (`[JIRA] (ABC-123) Summary`, the shape Jira's mails use), else the first word shaped like `ABC-123`
  (`[JIRA] Ann assigned OPS-5 to you`). A summary that holds `UTF-8` therefore does not take the key's place.
  No key in the title: the condition is false.
- **When it runs**: only after every other check of the rule held (sources, hours, all non-`jira.*` conditions,
  and for an act rule that the item is new or changed and offers the action), and before `jev`. So mail that is
  not from Jira costs no lookup; the order inside `when` does not matter. One lookup per item version, shared by
  every rule that asks.
- **Fresh**: the lookup asks for an answer no older than the item, so a mail about a status change is judged
  against the status after the change.
- **False vs retry**: no key, no Jira plugin, an issue the plugin does not know or may not see: the condition is
  false and the next rule may take the item (logged as step `jira`). A busy or failing Jira plugin (its limits, the
  network) is not an answer about the issue: the item waits like a Jev outage (no lower rule fires), is looked up
  again in 10 minutes, at most 4 tries, and then the condition is false (logged).
- A mail made to match is still one outsiders can trigger; `jira.*` narrows the rule, it does not make a loose
  `from` safe.

Example, an act rule that marks Jira's mail read once its issue is neither In Progress nor Backlog, and again when
a new message arrives in the thread (`onChange`):

```json
{ "id": "jira-mail-mark-read", "sources": ["bronos.gmail"], "onChange": true,
  "when": [{ "field": "from.address", "op": "is", "value": "jira@example.atlassian.net" },
           { "field": "title", "op": "startsWith", "value": "[JIRA]" },
           { "field": "jira.status", "op": "notIn", "value": ["In Progress", "Backlog"] }],
  "act": "markRead" }
```

### Jev

`"jev": { "question": "Does this message report that a website is down right now?", "min": 0.7 }`: Jev (a cheap
model, the `jev` plugin) scores the item's **title and preview only** against the question from 0 to 1, and
the rule holds at `min` or above (`min` from 0 to 1, default 0.7; the question 1 to 1000 characters). Answers are
cached per item version. Use it when the wording varies too much for `contains`, and combine it with `when` so
Jev is asked only about items that pass the cheap checks. It never sees the playbook.

### onChange on an act rule

An act rule with `"onChange": true` runs again on each **new version (rev)** of an item, judging its conditions
again (the `jira.*` ones too: a mail's thread gets a new message and the ticket has moved on). Once per version: a
change that is not a new version (marking the mail read does not move Gmail's rev) does not run it again, so it
cannot loop. Limits and cooldown count the actions, not the lookups. The session limits below do not apply (no
tab, nothing is delivered).

### onChange and its limits (a session rule)

By default a rule fires **once per item**: a reply or a new comment on the item is only logged ("updated, tab
open"). With `"onChange": true` a newer version of the item is sent into the **same tab** that investigates it.
The limits you must tell the person about:

- It needs cc-cockpit 0.11 (older apps cannot tell whether the person typed, so nothing is sent).
- Updates are merged: at most one is pending per item, so five messages during one run arrive as one delivery
  of the item's latest state.
- An update is delivered only when Claude in that tab is **waiting for input**, never while it works or waits
  for a permission answer.
- At most **5 updates** go into one tab.
- **Typing takes over**: once the person presses a key in the tab, Autopilot sends nothing more there until the
  tab closes (clicking and scrolling do not count; a paste does).
- None after the session ran `ccc autopilot stop` (the prompt tells it to when it stops: check not met, injection
  suspected, nothing more to do).
- The person's own reply is not delivered, but only when the project setting `myNames` lists their names or
  addresses; empty means no such check.
- Every update is outside text entering the session, so an `onChange` rule on a source outsiders can reach is a
  bigger exposure than a plain one.
- A closed tab frees the item: with `onChange`, the item's next new version goes through the rules again.

## base.md: the person's standing instructions

An optional `base.md` in a level's folder (beside `autopilot-rules.json`, at most 16 KiB) holds what the person
wants every Autopilot session to know: how to report, what never to touch, their names for things. Its text goes
into **every** session's prompt, after Autopilot's fixed frame and before the item (global first, then project).
It cannot remove or reorder the frame (the untrusted fence, the injection check, the permission of the rule's
mode). An act rule has no prompt, so base.md does not reach it. A `base.md` that is there but cannot be read (too
big, not a file) opens **no session** until it is fixed, since its limits may be what the person counts on.

- `ccc autopilot base` shows both levels' files; `ccc autopilot base set --global -` with the Markdown on stdin
  writes one (`ccc autopilot base set --global ''` removes it). Keep the person's text: edit what they asked
  for, not the rest.

## Playbooks

`playbooks/<name>.md` in the rule's level, at most 64 KiB; `<name>` is 1 to 64 letters, digits, `_` or `-`,
starting with a letter or digit (no dot, no slash). Write the playbook to the same level as its rule
(`playbooks set --project <name> -`): a global rule never reads a project's playbooks. Plain Markdown in the person's own words: what the session checks, how, and what it
reports. Autopilot wraps it in a fixed frame (the rule mode's permission, the item fenced as untrusted data, the
rule's `check` made first, a short summary at the end), so do not repeat that. The model and effort are the rule's: front matter in a
playbook is ignored with a warning.

- Name the places the session may check itself (your hosts, projects, URLs), so it never has to take one from the
  item. If a playbook must use a value from the item (the site to check), say exactly what shape it is (a plain
  public hostname, never a URL from the item) and have the session build the address itself.
- One playbook can serve several rules: rules of different weight differ in `model`, `effort` and `check`.
- Keep an investigate playbook read-only. The session runs in the person's normal permission mode, so anything
  it is not allowed to do waits at a prompt; do not write steps that change systems (restart, deploy, delete, send
  mail). When the person asks for such a step, make the rule `"mode": "act"` and list exactly that step under
  `## Allowed actions`, and say so in your answer.

## Testing a rule

`ccc autopilot test` is a dry run over the items **in the feeds now**, decided exactly as the live path decides.
No session starts and no rule is stored, and Jev is asked only with `--jev` (at most 10 questions, each a paid
request; without it a Jev rule shows what it would need). A rule with `jira.*` conditions shows the key found in
the title and "would look up ABC-123"; `--jira` makes the real lookups (read-only, at most 20) and shows the
status got, or the error.

- `ccc autopilot test <id>` (or `project:<id>`, `global:<id>`; an id both levels have needs the level): the stored
  rule, still decided over all rules of both levels, so "another rule comes first" shows as the answer to "why does
  mine not fire".
- `ccc autopilot test '<rule json>'` (or `-` with the JSON on stdin; add `--at <n>` for its place, and the level
  when both folders exist): a rule that is **not stored**, tested as on, in the place of the stored rule with the
  same id in that level or else at position `n` of that level (default last). Use it to try a change before
  `rules set`, and a new rule before `rules add`. The playbook must exist in that level.
- `ccc autopilot test`: every rule (`--project` / `--global`: only that level's rows).

Each row says which item, the rule, and "would fire" or "would not fire" with the reason (off, outside its hours,
Jev under `min`, already fired on this item, its tab is open, a limit, another rule comes first). An item already
in a feed when Autopilot was switched on never fires (it is the baseline), so a dry run can show "would fire" for
items the live run will not start; it tells you whether the rule matches, not whether it will run. If nothing
matches, say so and try a looser version of the condition against the current items before concluding the rule is
wrong. `ccc autopilot log` shows what actually ran or was skipped; `ccc autopilot reload` lists problems after a
hand edit.

## From v1 to v2

v2 reads `autopilot-rules.json`; v1's `rules.json` is never read (and never written), so an old file in a
rules folder does nothing. When a folder holds `rules.json` and no `autopilot-rules.json`, `ccc autopilot` and the
panel show one plain note about it, never an error. **Port it only when the person asks.** There is no automatic
migration: read the old file yourself (`cat <folder>/rules.json`), write each rule in the v2 format with
`rules add` (into the level the person wants), and leave `rules.json` where it is. An entry with `match` or
`triage` pasted into the new file is just an invalid rule (no `sources`), and its problem line says `match` is a
v1 key. The mapping:

| v1 | v2 |
|---|---|
| `match.source` | `sources` (a plugin id list); no source in v1 meant any: write `["*"]` only if that is really meant |
| `match.where` | a `place.name` `contains` condition in `when` |
| `match.from` | a `from.name` `contains` condition |
| `match.text` | a `title` `contains` condition |
| `match.level` | no equivalent: use `labels` or a Jev question |
| `triage.jev` | `jev` (same `question` and `min`) |
| `condition` | `check` |
| `on` | `enabled` |
| playbook model in front matter | `model` in the rule (front matter is ignored) |

Copy the playbooks the rules name into the same level's `playbooks/` (`playbooks set`); their text needs no
change. Port the rules **off** (`"enabled": false`), test each with the current feeds, and ask the person before
enabling any of them. If a v1 rule was on, the person expects it to fire again once enabled: say which of their
rules are now off and why.

## Examples

- "Investigate failed deploys in the Deploys space with sonnet": write `playbooks set investigate-deploy -` with
  what to check, then
  `ccc autopilot test '{"id":"deploy-failed","sources":["bronos.chat"],"when":[{"field":"place.name","op":"is","value":"Deploys"},{"field":"title","op":"contains","value":"failed"}],"playbook":"investigate-deploy","check":"A production deploy failed.","model":"sonnet"}'`,
  show the result, then the same JSON with `rules add`, and ask whether to `rules enable deploy-failed`.
- "Why did Autopilot not fire on that ticket?": `ccc autopilot test <rule id>` (the row for the item says why),
  then `ccc autopilot log 30` (a skip or a limit shows there). It was probably in the baseline, outside the
  rule's hours, under a limit, or taken by a rule above. A `claim` skip "running in another window" means
  another project's window opened it first: an item gets one tab app-wide (the dry run does not show this).
- "Mark the Jira-Done notification emails read": an act rule, no playbook:
  `ccc autopilot test '{"id":"done-mails-read","sources":["bronos.gmail"],"when":[{"field":"from.address","op":"is","value":"tracker@example.com"},{"field":"title","op":"contains","value":"Done"}],"act":"markRead"}'`
  shows "would run markRead" for the matching mails; then `rules add` it and ask before `rules enable`.
- "Stop the Jira rule for now": `ccc autopilot rules disable <id>`. To stop everything, `ccc autopilot off`.
- "Put the urgent mail rule above the catch-all": `ccc autopilot rules move <id> 1`.
- "Mail from my lead": `{"id":"lead-mail","sources":["bronos.gmail"],"when":[{"field":"from.address","op":"is","value":"lead@example.com"}],"jev":{"question":"Does this email ask for something urgent?","min":0.8},"playbook":"triage-mail"}`.
  Mail is a source outsiders write to: tell the person, and keep the playbook read-only.
