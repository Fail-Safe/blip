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

## Two marks, not one

`state.json` tracks `watermark` (highest ts the collector has *seen*, drives
toast eligibility) and `readMark` (highest ts Fred has *looked at*, drives the
badge). Collapsing them is a bug: the poll watermark advances every tick, so a
badge measured against it flashes to 1 and resets six seconds later.

## Known limits (v0.1)

- **Group threads are read-only.** They carry an opaque `chat_identifier`
  (`chat.style=43`), but AppleScript needs the full GUID (`any;+;<id>`), which
  `imsg --json` does not expose. Rather than risk delivering to the wrong
  thread, sending is restricted to DMs. Reading groups works fine.
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
