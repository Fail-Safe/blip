#!/usr/bin/env bun
/**
 * Blip thread loader — fetches one conversation and decorates it for the
 * bubble view.
 *
 * The decoration (day separators, sender grouping, which bubble shows a
 * timestamp) is pure and lives here rather than in QML so it can be tested.
 * QML just renders what it is handed.
 *
 *   bun thread.ts <chat-id> [limit]
 */

import { spawnSync } from "node:child_process";
import { chatKey, dedupeSelfEcho, isGroupChat, type ImsgMessage } from "./collector";
export { dedupeSelfEcho };

const HOME = process.env.HOME ?? "/home/pi";

/** Messages closer together than this belong to the same visual cluster. */
export const GROUP_GAP_MINUTES = 15;

export interface Bubble {
  ts: string;
  from_me: boolean;
  name: string;
  text: string;
  /** Non-empty on the first message of a new calendar day: "Today", "Aug 28". */
  day: string;
  /** First bubble of a run by one sender — gets the rounded outer corner. */
  groupStart: boolean;
  /** Last bubble of a run — carries the timestamp, like iMessage. */
  groupEnd: boolean;
  /** "9:41 PM", shown only on groupEnd. */
  time: string;
}

export interface ThreadOutput {
  ok: boolean;
  online: boolean;
  error: string;
  bubbles: Bubble[];
}

// ---------------------------------------------------------------- formatting

/** "2026-08-30 21:08:22" → "9:08 PM". Avoids Date parsing and its TZ surprises. */
export function clockLabel(ts: string): string {
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/.exec(ts);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${suffix}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today" / "Yesterday" / "Aug 28" / "Aug 28, 2025" for an older year. */
export function dayLabel(ts: string, today: string): string {
  const date = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  if (date === today) return "Today";

  const d = new Date(`${date}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diffDays === 1) return "Yesterday";

  const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  const dayNum = Number(date.slice(8, 10));
  const year = date.slice(0, 4);
  return year === today.slice(0, 4) ? `${month} ${dayNum}` : `${month} ${dayNum}, ${year}`;
}

/** Minutes between two "YYYY-MM-DD HH:MM:SS" stamps. */
export function minutesBetween(a: string, b: string): number {
  const pa = Date.parse(a.replace(" ", "T"));
  const pb = Date.parse(b.replace(" ", "T"));
  if (Number.isNaN(pa) || Number.isNaN(pb)) return Number.POSITIVE_INFINITY;
  return Math.abs(pb - pa) / 60000;
}

// ---------------------------------------------------------------- decoration

/**
 * Turn a chronological message list into bubbles.
 *
 * A new group starts when the sender changes, the day changes, or more than
 * GROUP_GAP_MINUTES have passed. Only the last bubble of a group shows its
 * timestamp — that is what keeps a long back-and-forth readable instead of
 * stamping every single line.
 */
export function decorate(msgs: ImsgMessage[], today: string): Bubble[] {
  const out: Bubble[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const prev = i > 0 ? msgs[i - 1]! : null;
    const next = i < msgs.length - 1 ? msgs[i + 1]! : null;

    const newDay = !prev || prev.ts.slice(0, 10) !== m.ts.slice(0, 10);
    // In a group, two members' messages must not merge into one run under
    // the first name — so a run breaks on sender (handle) change, not only
    // on the from_me flip.
    const sameSender = (a: ImsgMessage, b: ImsgMessage) =>
      a.from_me === b.from_me && (a.from_me || a.handle === b.handle);
    const groupStart =
      !prev ||
      newDay ||
      !sameSender(prev, m) ||
      minutesBetween(prev.ts, m.ts) > GROUP_GAP_MINUTES;
    const groupEnd =
      !next ||
      next.ts.slice(0, 10) !== m.ts.slice(0, 10) ||
      !sameSender(m, next) ||
      minutesBetween(m.ts, next.ts) > GROUP_GAP_MINUTES;

    out.push({
      ts: m.ts,
      from_me: m.from_me,
      name: m.name ?? m.handle ?? "",
      text: m.text ?? "",
      day: newDay ? dayLabel(m.ts, today) : "",
      groupStart,
      groupEnd,
      time: groupEnd ? clockLabel(m.ts) : "",
    });
  }

  return out;
}

/** Local calendar date — toISOString() is UTC and flips "Today" at 8pm EDT. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** How far back to scan `recent` for a group's messages. */
export const GROUP_SCAN_WINDOW = 1500;

/**
 * Normalise a fetched window into this thread's chronological messages.
 * `recent` is newest-first and mixed across chats; `thread` is already
 * oldest-first and single-chat. Both end up oldest-first, last `limit` only.
 */
export function selectThread(raw: ImsgMessage[], chat: string, group: boolean, limit: number): ImsgMessage[] {
  let msgs = group ? raw.filter((m) => chatKey(m) === chat) : raw;
  msgs = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  msgs = dedupeSelfEcho(msgs);
  return msgs.length > limit ? msgs.slice(msgs.length - limit) : msgs;
}

// ---------------------------------------------------------------- transport

export function loadThread(
  chat: string,
  limit: number,
  today: string,
  runner = spawnSync,
): ThreadOutput {
  // `imsg thread` matches by HANDLE substring, so a group's 32-hex chat id
  // never hits. For groups, pull a wide recent window and filter by chat.
  const group = isGroupChat(chat);
  const args = group
    ? ["--json", "recent", String(GROUP_SCAN_WINDOW)]
    : ["--json", "thread", chat, String(limit)];
  const res = runner(`${HOME}/bin/imsg`, args, {
    encoding: "utf8",
    timeout: 15000,
  });

  if (res.status === 69) {
    return { ok: false, online: false, error: "fnix unreachable", bubbles: [] };
  }
  if (res.status !== 0) {
    const err = (res.stderr || "").toString().trim().split("\n")[0] || `imsg exit ${res.status}`;
    return { ok: false, online: true, error: err, bubbles: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout as string);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const msgs = selectThread(parsed as ImsgMessage[], chat, group, limit);
    return { ok: true, online: true, error: "", bubbles: decorate(msgs, today) };
  } catch (e) {
    return { ok: false, online: true, error: `bad JSON from imsg: ${e}`, bubbles: [] };
  }
}

if (import.meta.main) {
  const chat = process.argv[2] ?? "";
  const limit = Number(process.argv[3] ?? 80) || 80;
  const today = localToday();
  try {
    console.log(JSON.stringify(loadThread(chat, limit, today)));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, online: false, error: String(e), bubbles: [] }));
  }
}
