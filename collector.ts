#!/usr/bin/env bun
/**
 * Blip collector — turns fnix's `imsg --json recent N` into the thread model
 * the QML bar widget and panel render.
 *
 * iMessage is macOS-only. chat.db and the AppleScript send path both live on
 * fnix; vic is a thin client over a multiplexed SSH socket (~47ms warm). This
 * script never touches SQLite itself — it shells out to ~/bin/imsg, which
 * proxies to fnix.
 *
 * Output: one JSON object on stdout. Never throws — a failure is reported as
 * {ok:false, online:false} so the bar can grey out instead of crashing.
 *
 *   bun collector.ts            # poll: shallow window, badge + toasts
 *   bun collector.ts --deep     # panel open: wider window, full thread list
 *   bun collector.ts --mark-read        # clear every dot (right-click)
 *   bun collector.ts --read <chat>      # clear one thread's dot (opened it)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME ?? "/home/pi";

/** Watermark + toast dedupe. ~/.local/state is deliberate: never inside a repo. */
export const STATE_PATH = `${HOME}/.local/state/blip/state.json`;
/** Handles whose inbound messages are allowed to raise a desktop toast. */
export const ALLOWLIST_PATH = `${HOME}/.config/blip/allowlist.json`;

/**
 * Shallow poll window. Unread is counted inside this window, so it must be
 * wide enough that a burst of bank alerts cannot push a real unread out of it
 * and silently drop the badge. 150 msgs ≈ 40KB per tick.
 */
export const POLL_WINDOW = 150;
/** Deep window, fetched when the panel opens and needs a real thread list. */
export const DEEP_WINDOW = 500;

export interface ImsgMessage {
  ts: string;          // "YYYY-MM-DD HH:MM:SS" — lexically sortable, which we rely on
  from_me: boolean;
  handle: string;
  name: string | null;
  service: string;
  chat: string;        // phone/email for DMs, opaque GUID for group chats
  text: string;
}

export interface Thread {
  chat: string;
  name: string;
  handle: string;
  service: string;
  last_ts: string;
  last_text: string;
  last_from_me: boolean;
  count: number;       // messages for this chat inside the fetched window
  unread: number;      // inbound newer than the watermark
}

export interface Toast {
  chat: string;
  name: string;
  text: string;
  ts: string;
}

/**
 * Two marks, deliberately. Collapsing them into one is a bug: the poll
 * watermark advances every tick, so an unread count measured against it would
 * flash to 1 and fall back to 0 on the next poll six seconds later.
 *
 *   watermark — highest ts the collector has *seen*. Drives toast eligibility.
 *   readMark  — highest ts Fred has actually *looked at*. Drives the badge.
 *               Only moves on --mark-read (panel open, or middle-click).
 */
export interface BlipState {
  watermark: string;
  readMark: string;
  /** Per-thread read marks — iMessage semantics: the blue dot stays on a
   *  thread until THAT conversation is opened, not until the list is viewed. */
  readMarks: Record<string, string>;
  toasted: string[];   // recent "ts|chat|text" keys, for self-thread echo dedupe
}

export interface BlipOutput {
  ok: boolean;
  online: boolean;
  error: string;
  ts: string;
  unread: number;
  threads: Thread[];
  toast: Toast[];
}

// ---------------------------------------------------------------- state I/O

export function loadState(path = STATE_PATH): BlipState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<BlipState>;
    const watermark = typeof s.watermark === "string" ? s.watermark : "";
    return {
      watermark,
      // Pre-two-mark state files have no readMark. Inheriting the watermark is
      // the safe migration: it reports zero unread rather than a fake backlog.
      readMark: typeof s.readMark === "string" ? s.readMark : watermark,
      readMarks: s.readMarks && typeof s.readMarks === "object" ? { ...s.readMarks } : {},
      toasted: Array.isArray(s.toasted) ? s.toasted.slice(-200) : [],
    };
  } catch {
    return { watermark: "", readMark: "", readMarks: {}, toasted: [] };
  }
}

export function saveState(state: BlipState, path = STATE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Cap the dedupe ring so the file cannot grow without bound.
    writeFileSync(path, JSON.stringify({ ...state, toasted: state.toasted.slice(-200) }));
  } catch {
    /* a read-only state dir must not take the bar down */
  }
}

export function loadAllowlist(path = ALLOWLIST_PATH): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(raw) ? raw : raw?.allow;
    return Array.isArray(list) ? list.filter((h: unknown) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- transform

/** Display name for a chat, falling back to the raw handle for unknown numbers. */
export function displayName(msgs: ImsgMessage[]): string {
  for (const m of msgs) if (m.name) return m.name;
  return chatKey(msgs[0]);
}

/** Group chat ids are 32 hex chars (chat.style=43); DMs are a phone or email. */
export function isGroupChat(chat: string): boolean {
  return /^[0-9a-f]{32}$/i.test(chat);
}

/**
 * The self-thread logs every send twice: a from_me=true row and a from_me=false
 * twin carrying the same ts+text. Left alone, every message Fred sends himself
 * counts as unread and re-lights the dot. Collapse the pair and attribute it
 * to me. Shared with thread.ts so the list and the bubbles agree.
 */
export function dedupeSelfEcho(msgs: ImsgMessage[]): ImsgMessage[] {
  const sentAt = new Set(msgs.filter((m) => m.from_me && m.text === "").map((m) => m.ts));
  const out: ImsgMessage[] = [];
  for (const m of msgs) {
    if (m.text === "") continue;
    const idx = out.findIndex((o) => o.ts === m.ts && o.text === m.text && chatKey(o) === chatKey(m));
    if (idx >= 0) {
      if (m.from_me) out[idx] = { ...out[idx]!, from_me: true };
      continue;
    }
    out.push(sentAt.has(m.ts) && !m.from_me ? { ...m, from_me: true } : m);
  }
  return out;
}

/**
 * imsg returns chat:null for some rows (no chat join — typically one-off SMS
 * from short codes). Fall back to the handle so the row still has an identity
 * and never renders as the string "null".
 */
export function chatKey(m: ImsgMessage | undefined): string {
  if (!m) return "";
  return String(m.chat || m.handle || "");
}

/**
 * Group a flat message window into threads, newest-first.
 *
 * `unread` counts inbound messages strictly newer than the thread's read mark:
 * the per-thread mark if one exists, else the global one. Outbound is never
 * unread, and on an empty global mark (first ever run) nothing is unread —
 * otherwise the very first poll would claim 60 new messages.
 */
export function buildThreads(
  msgs: ImsgMessage[],
  watermark: string,
  readMarks: Record<string, string> = {},
): Thread[] {
  const byChat = new Map<string, ImsgMessage[]>();
  for (const m of msgs) {
    const key = chatKey(m);
    const list = byChat.get(key);
    if (list) list.push(m);
    else byChat.set(key, [m]);
  }

  const threads: Thread[] = [];
  for (const [chat, list] of byChat) {
    const sorted = [...list].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const last = sorted[sorted.length - 1]!;
    const mark = readMarks[chat] && readMarks[chat]! > watermark ? readMarks[chat]! : watermark;
    const unread = watermark
      ? sorted.filter((m) => !m.from_me && m.ts > mark).length
      : 0;
    threads.push({
      chat,
      // Groups have no display_name in imsg's output; label them so the list
      // does not pass one participant off as the whole conversation.
      name: isGroupChat(chat) ? displayName(sorted) + " +group" : displayName(sorted),
      handle: String(last.handle || chat),
      service: last.service,
      last_ts: last.ts,
      last_text: last.text,
      last_from_me: last.from_me,
      count: sorted.length,
      unread,
    });
  }

  threads.sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0));
  return threads;
}

/** Stable key for one message, used to suppress repeat toasts. */
export function toastKey(m: ImsgMessage): string {
  return `${m.ts}|${chatKey(m)}|${m.text}`;
}

/**
 * Pick the messages that earn a desktop notification.
 *
 * Gated three ways, because chat.db is mostly Truist alerts and 2FA codes:
 *   1. inbound only, and strictly newer than the watermark
 *   2. sender (chat OR handle) is on the allowlist
 *   3. not already toasted — this is what stops the self-thread echo storm,
 *      where Larry's own sent replies come back as from_me=false
 */
export function selectToasts(
  msgs: ImsgMessage[],
  watermark: string,
  allow: string[],
  toasted: string[],
): Toast[] {
  if (!watermark) return [];          // never toast the backlog on first run
  const allowed = new Set(allow);
  const seen = new Set(toasted);
  const out: Toast[] = [];

  for (const m of msgs) {
    if (m.from_me) continue;
    if (m.ts <= watermark) continue;
    if (!allowed.has(chatKey(m)) && !allowed.has(m.handle)) continue;
    const key = toastKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chat: chatKey(m), name: m.name ?? m.handle, text: m.text, ts: m.ts });
  }
  return out;
}

export function maxTs(msgs: ImsgMessage[], fallback: string): string {
  let hi = fallback;
  for (const m of msgs) if (m.ts > hi) hi = m.ts;
  return hi;
}

// ---------------------------------------------------------------- transport

export interface FetchResult {
  ok: boolean;
  online: boolean;
  error: string;
  msgs: ImsgMessage[];
}

/** Call the imsg shim. Exit 69 is its documented "fnix unreachable" code. */
export function fetchMessages(limit: number, runner = spawnSync): FetchResult {
  const res = runner(`${HOME}/bin/imsg`, ["--json", "recent", String(limit)], {
    encoding: "utf8",
    timeout: 15000,
  });

  if (res.status === 69) {
    return { ok: false, online: false, error: "fnix unreachable", msgs: [] };
  }
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return { ok: false, online: true, error: err, msgs: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return { ok: true, online: true, error: "", msgs: parsed as ImsgMessage[] };
  } catch (e) {
    return { ok: false, online: true, error: `bad JSON from imsg: ${e}`, msgs: [] };
  }
}

// ---------------------------------------------------------------- main

export function collect(deep: boolean, markRead = false, readChat = ""): BlipOutput {
  const now = new Date().toISOString();
  const state = loadState();
  const fetched = fetchMessages(deep ? DEEP_WINDOW : POLL_WINDOW);

  if (!fetched.ok) {
    return {
      ok: false,
      online: fetched.online,
      error: fetched.error,
      ts: now,
      unread: 0,
      threads: [],
      toast: [],
    };
  }

  const highest = maxTs(fetched.msgs, state.watermark);
  // Badge counts against readMark (what Fred has seen); toasts fire against
  // watermark (what the collector has seen). See BlipState.
  const readMark = markRead ? highest : state.readMark;
  // Opening one conversation clears only that thread's dot.
  const readMarks = { ...state.readMarks };
  if (readChat) readMarks[readChat] = highest;
  const msgs = dedupeSelfEcho(fetched.msgs);
  const threads = buildThreads(msgs, readMark, readMarks);
  const toast = selectToasts(msgs, state.watermark, loadAllowlist(), state.toasted);
  const unread = threads.reduce((n, t) => n + t.unread, 0);

  // Both marks advance only on a good fetch, so an outage cannot silently
  // swallow the messages that arrived during it.
  saveState({
    watermark: highest,
    // First ever run: adopt the current high-water rather than reporting the
    // whole 60-message window as unread the moment the plugin is installed.
    readMark: state.readMark === "" ? highest : readMark,
    readMarks,
    toasted: [...state.toasted, ...toast.map((t) => `${t.ts}|${t.chat}|${t.text}`)],  // == toastKey
  });

  return { ok: true, online: true, error: "", ts: now, unread, threads, toast };
}

if (import.meta.main) {
  const deep = process.argv.includes("--deep");
  const markRead = process.argv.includes("--mark-read");
  const ri = process.argv.indexOf("--read");
  const readChat = ri >= 0 ? String(process.argv[ri + 1] ?? "") : "";
  try {
    console.log(JSON.stringify(collect(deep, markRead, readChat)));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false, online: false, error: String(e), ts: new Date().toISOString(),
        unread: 0, threads: [], toast: [],
      }),
    );
  }
}
