# Blip

iMessage in the Omarchy bar, on Linux.

iMessage is macOS-only. `chat.db` and the AppleScript send path both live on
**fnix** (Fred's MacBook Pro). vic is a thin client over a multiplexed SSH
socket; fnix is the gateway. **fnix has to be awake** — that is inherent, not a
bug.

## What it does

- **Bar badge** — unread count across every thread. Dimmed + slashed glyph when
  fnix is unreachable.
- **Panel** — thread list (newest first, unread marked), tap into any thread for
  history, compose box to reply.
- **Toasts** — desktop notification only for handles in
  `~/.config/blip/allowlist.json`. Everything else still counts toward the badge
  and appears in the panel; the allowlist only governs *interruption*. chat.db
  is 15k Truist alerts and a steady drip of 2FA codes, so this gate matters.

Left-click = panel · middle-click = refresh · right-click = mark all read.
In the panel: `j`/`k` + Enter or `1`–`9` to open a thread, `r` to refresh,
Esc to go back.

## Requires

- `~/bin/imsg` and `~/bin/imsg-send` (the vic→fnix shims, in `~/.claude/bin`)
- `ControlMaster` configured for fnix in `~/.ssh/config` (205ms → 47ms)
- `bun`, `notify-send`

## Why sshd and not cron

`sshd` on fnix holds **both** Full Disk Access (to read chat.db) **and**
Automation→Messages (to drive AppleScript). cron holds neither — verified
2026-06-11, see `fnix:~/.claude/Tools/imsg-loop-watchdog.sh`. SSH is a working
transport exactly where cron was a dead end.

## Unread dots are per thread

Like iMessage, the blue dot beside a name stays until *that* conversation is
opened — viewing the list does not clear it. `state.json` keeps `readMarks`
(one timestamp per chat) alongside the global `readMark`; right-click on the
bar widget still clears everything.

## Sync latency and deletions

Blip polls fnix's chat.db every **6 s** and caches no message content, so it
is never more than one tick behind fnix. Phone → fnix is Apple's job (Messages
in iCloud, on): usually seconds while fnix is awake. **Deletions** land in a
30-day "Recently Deleted" bin (`chat_recoverable_message_join`) that stays in
chat.db; fnix's `imsg` hides those rows by default since 2026-08-30, so a
conversation deleted on the phone disappears from Blip within one poll of the
iCloud sync. `IMSG_INCLUDE_DELETED=1` shows them again.

## Two marks, not one

`state.json` tracks `watermark` (highest ts the collector has *seen*, drives
toast eligibility) and `readMark` (highest ts Fred has *looked at*, drives the
badge). Collapsing them is a bug: the poll watermark advances every tick, so a
badge measured against it flashes to 1 and resets six seconds later.

## The conversation view

Real bubbles: yours blue on the right, theirs grey on the left, grouped by
sender with one timestamp per run and day dividers — computed in `thread.ts`
(unit-tested), rendered by `Panel.qml`. Typing works because the panel sets
`PanelKeyCatcher.blocked: composeField.activeFocus`; without it the catcher
eats every keystroke before the compose box sees one. Enter sends.

IPC: `qs -p /usr/share/omarchy/shell ipc call nixfred.blip goto 14089216687`
opens a thread directly (bare digits — `qs` rejects a leading `+` as a flag,
and `show` collides with `qs ipc show`).

## Groups

Titled the way Messages.app does it: the group's `display_name` when it has one
("LMT"), else the members' names ("Craig Chapman, Scott Lewis"). Metadata comes
from `imsg groups` — a vic-side shim subcommand over sqlite on fnix — refreshed
on deep fetches and cached in `state.json`. Sender names sit above each run.

## Copying

Bubbles are read-only `TextEdit`s: drag to select, Ctrl+C. Right-click a
bubble to copy the whole message (`wl-copy`, fed via stdin).

## Read receipts — not possible

Tested 2026-08-30: opening a conversation on fnix via `open imessage://<handle>`
left every unread row's `is_read` untouched. Marking read needs Apple's private
API (BlueBubbles territory). Not built.

## Known limits

- **Group sends** go `--chat-id` with the full AppleScript GUID (`any;+;<id>`)
  that `imsg groups` supplies; a group whose GUID is not cached yet is read-only
  rather than guessed. Verified live 2026-08-30 (LMT). `is_delivered` stays 0
  for group rows in chat.db even when delivery succeeds — do not read it as a
  failure.
- **No attachments.** Text only, both directions.
- **No tapbacks / edits / threading.** AppleScript cannot do them; that needs
  Apple's private API (see BlueBubbles).
- The panel shows a rolling window (500 messages deep on open), not all 273k.
  Full-history search is available from the CLI: `imsg search "..."`.

## State

| Path | What |
| --- | --- |
| `~/.local/state/blip/state.json` | watermark, readMark, toast dedupe ring |
| `~/.config/blip/allowlist.json` | handles allowed to raise a toast |

Both live outside any git repo on purpose — 273,685 personal messages must
never end up committed.
