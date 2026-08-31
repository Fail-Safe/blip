import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildThreads,
  fetchGroups,
  groupName,
  dedupeSelfEcho,
  isGroupChat,
  displayName,
  fetchMessages,
  loadAllowlist,
  loadState,
  maxTs,
  saveState,
  selectToasts,
  toastKey,
  type ImsgMessage,
} from "./collector";

const tmp = () => mkdtempSync(join(tmpdir(), "blip-test-"));

function msg(over: Partial<ImsgMessage> = {}): ImsgMessage {
  return {
    ts: "2026-08-30 12:00:00",
    from_me: false,
    handle: "+15551234567",
    name: "Test Person",
    service: "iMessage",
    chat: "+15551234567",
    text: "hello",
    ...over,
  };
}

describe("buildThreads", () => {
  test("groups by chat and keeps the newest message as the preview", () => {
    const threads = buildThreads(
      [
        msg({ chat: "A", ts: "2026-08-30 10:00:00", text: "older" }),
        msg({ chat: "A", ts: "2026-08-30 11:00:00", text: "newer" }),
        msg({ chat: "B", ts: "2026-08-30 09:00:00", text: "b only" }),
      ],
      "",
    );
    expect(threads).toHaveLength(2);
    expect(threads[0]!.chat).toBe("A");          // newest thread first
    expect(threads[0]!.last_text).toBe("newer");
    expect(threads[0]!.count).toBe(2);
  });

  test("orders threads newest-first regardless of input order", () => {
    const threads = buildThreads(
      [
        msg({ chat: "old", ts: "2026-01-01 00:00:00" }),
        msg({ chat: "new", ts: "2026-08-30 23:59:59" }),
        msg({ chat: "mid", ts: "2026-05-05 12:00:00" }),
      ],
      "",
    );
    expect(threads.map((t) => t.chat)).toEqual(["new", "mid", "old"]);
  });

  test("first run reports zero unread — an empty watermark must not flag the backlog", () => {
    const threads = buildThreads([msg({ ts: "2026-08-30 10:00:00" })], "");
    expect(threads[0]!.unread).toBe(0);
  });

  test("counts only inbound messages newer than the watermark", () => {
    const threads = buildThreads(
      [
        msg({ ts: "2026-08-30 09:00:00" }),                     // old inbound
        msg({ ts: "2026-08-30 11:00:00" }),                     // new inbound  ✓
        msg({ ts: "2026-08-30 12:00:00", from_me: true }),      // new outbound ✗
      ],
      "2026-08-30 10:00:00",
    );
    expect(threads[0]!.unread).toBe(1);
  });

  test("a message exactly at the watermark is not unread", () => {
    const threads = buildThreads([msg({ ts: "2026-08-30 10:00:00" })], "2026-08-30 10:00:00");
    expect(threads[0]!.unread).toBe(0);
  });

  test("group-chat GUID chat ids survive as their own thread", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    const threads = buildThreads([msg({ chat: guid, name: "Craig Chapman" })], "");
    expect(threads[0]!.chat).toBe(guid);
  });

  test("the same person across a DM and a group stays two threads", () => {
    // Robert Terlizzi really does appear under both a phone handle and a GUID.
    const threads = buildThreads(
      [
        msg({ chat: "+14089216687", name: "Robert Terlizzi" }),
        msg({ chat: "4d1c08ae0eb64c88acfe7d68473f0124", name: "Robert Terlizzi" }),
      ],
      "",
    );
    expect(threads).toHaveLength(2);
  });

  test("handles an empty window", () => {
    expect(buildThreads([], "2026-01-01 00:00:00")).toEqual([]);
  });

  test("a per-thread read mark clears only that thread", () => {
    const threads = buildThreads(
      [
        msg({ chat: "A", handle: "A", ts: "2026-08-30 11:00:00" }),
        msg({ chat: "B", handle: "B", ts: "2026-08-30 11:00:00" }),
      ],
      "2026-08-30 10:00:00",
      { A: "2026-08-30 11:00:00" },
    );
    const byChat = Object.fromEntries(threads.map((t) => [t.chat, t.unread]));
    expect(byChat).toEqual({ A: 0, B: 1 });
  });

  test("a stale per-thread mark never resurrects unread below the global mark", () => {
    const threads = buildThreads(
      [msg({ chat: "A", handle: "A", ts: "2026-08-30 09:30:00" })],
      "2026-08-30 10:00:00",
      { A: "2026-08-30 09:00:00" },
    );
    expect(threads[0]!.unread).toBe(0);
  });

  test("a null chat falls back to the handle — never the string \"null\"", () => {
    // Seen live: a staffing-spam SMS came back with chat:null and rendered as "null".
    const threads = buildThreads(
      [msg({ chat: null as unknown as string, handle: "+212657741612", name: null })],
      "",
    );
    expect(threads[0]!.chat).toBe("+212657741612");
    expect(threads[0]!.name).toBe("+212657741612");
    expect(threads[0]!.handle).toBe("+212657741612");
  });
});

describe("isGroupChat", () => {
  test("32 hex = group", () => expect(isGroupChat("053856bb0d9a40e392db59eace1c56d1")).toBe(true));
  test("phone = DM", () => expect(isGroupChat("+14089216687")).toBe(false));
  test("email = DM", () => expect(isGroupChat("someone@icloud.com")).toBe(false));
});

describe("self-echo in the thread list", () => {
  test("a message Fred sends himself does not count as unread", () => {
    // Without this every panel send to the self-thread re-lit the dot.
    const msgs = dedupeSelfEcho([
      msg({ chat: "+14049538305", handle: "+14049538305", ts: "2026-08-30 11:00:00", from_me: true, text: "note" }),
      msg({ chat: "+14049538305", handle: "+14049538305", ts: "2026-08-30 11:00:00", from_me: false, text: "note" }),
    ]);
    const threads = buildThreads(msgs, "2026-08-30 10:00:00");
    expect(threads[0]!.unread).toBe(0);
    expect(threads[0]!.last_from_me).toBe(true);
  });

  test("the same text in two different chats at one ts is two messages", () => {
    const msgs = dedupeSelfEcho([
      msg({ chat: "A", handle: "A", ts: "2026-08-30 11:00:00", text: "ok" }),
      msg({ chat: "B", handle: "B", ts: "2026-08-30 11:00:00", text: "ok" }),
    ]);
    expect(msgs).toHaveLength(2);
  });

  test("a named group uses its display_name", () => {
    const guid = "ce5a593a78af408282d61461ade89135";
    const threads = buildThreads([msg({ chat: guid, name: "Thomas Dodd" })], "", {}, { [guid]: { name: "LMT", guid: "any;+;" + guid, participants: ["+1"] } });
    expect(threads[0]!.name).toBe("LMT");
    expect(threads[0]!.guid).toBe("any;+;" + guid);
  });

  test("a group with no cached metadata has an empty guid and stays unsendable", () => {
    const threads = buildThreads([msg({ chat: "053856bb0d9a40e392db59eace1c56d1" })], "");
    expect(threads[0]!.guid).toBe("");
  });

  test("a DM never carries a guid", () => {
    expect(buildThreads([msg()], "")[0]!.guid).toBe("");
  });

  test("an unnamed group lists its members, resolving names from the window", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    const threads = buildThreads(
      [msg({ chat: guid, handle: "+16164385399", name: "Craig Chapman" })],
      "", {},
      { [guid]: { name: "", guid: "any;+;" + guid, participants: ["+16164385399", "+19543953540"] } },
    );
    expect(threads[0]!.name).toBe("Craig Chapman, +19543953540");
  });

  test("a group with no metadata at all falls back to its id, never one member", () => {
    const guid = "053856bb0d9a40e392db59eace1c56d1";
    expect(groupName(guid, undefined, new Map())).toBe(guid);
  });
});

describe("displayName", () => {
  test("prefers the first resolved contact name", () => {
    expect(displayName([msg({ name: null }), msg({ name: "Crystal Nix" })])).toBe("Crystal Nix");
  });

  test("falls back to the chat id when nobody is named", () => {
    // `imsg chats` returns name:null, and unknown numbers never resolve.
    expect(displayName([msg({ name: null, chat: "878478" })])).toBe("878478");
  });
});

describe("selectToasts", () => {
  const allow = ["+19546961726"];

  test("a null-chat toast carries the handle, never the string null", () => {
    const out = selectToasts(
      [msg({ chat: null as unknown as string, handle: "+19546961726", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out[0]!.chat).toBe("+19546961726");
  });

  test("toasts an allowlisted inbound message", () => {
    const out = selectToasts(
      [msg({ chat: "+19546961726", handle: "+19546961726", name: "Crystal Nix", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Crystal Nix");
  });

  test("drops senders that are not allowlisted", () => {
    // Truist alerts and Instagram 2FA are the reason this gate exists.
    const out = selectToasts(
      [msg({ chat: "878478", handle: "878478", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("never toasts outbound", () => {
    const out = selectToasts(
      [msg({ chat: "+19546961726", handle: "+19546961726", from_me: true, ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("never toasts the backlog on first run", () => {
    const out = selectToasts(
      [msg({ chat: "+19546961726", handle: "+19546961726", ts: "2026-08-30 11:00:00" })],
      "",
      allow,
      [],
    );
    expect(out).toEqual([]);
  });

  test("suppresses a message already toasted — the self-thread echo guard", () => {
    // In Fred's own thread, Larry's sent replies come back as from_me=false.
    // Without this dedupe the loop would notify on its own output forever.
    const m = msg({ chat: "+14049538305", handle: "+14049538305", ts: "2026-08-30 11:00:00", text: "echo" });
    const out = selectToasts([m], "2026-08-30 10:00:00", ["+14049538305"], [toastKey(m)]);
    expect(out).toEqual([]);
  });

  test("deduplicates identical messages within a single batch", () => {
    const m = msg({ chat: "+19546961726", handle: "+19546961726", ts: "2026-08-30 11:00:00" });
    const out = selectToasts([m, { ...m }], "2026-08-30 10:00:00", allow, []);
    expect(out).toHaveLength(1);
  });

  test("matches on handle when the chat id is an opaque GUID", () => {
    const out = selectToasts(
      [msg({ chat: "053856bb0d9a40e392db59eace1c56d1", handle: "+16164385399", ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      ["+16164385399"],
      [],
    );
    expect(out).toHaveLength(1);
  });

  test("an empty allowlist toasts nothing", () => {
    const out = selectToasts(
      [msg({ ts: "2026-08-30 11:00:00" })],
      "2026-08-30 10:00:00",
      [],
      [],
    );
    expect(out).toEqual([]);
  });
});

describe("maxTs", () => {
  test("returns the highest timestamp", () => {
    expect(maxTs([msg({ ts: "2026-08-30 09:00:00" }), msg({ ts: "2026-08-30 11:00:00" })], "")).toBe(
      "2026-08-30 11:00:00",
    );
  });

  test("never moves the watermark backwards on a short window", () => {
    expect(maxTs([msg({ ts: "2026-01-01 00:00:00" })], "2026-08-30 10:00:00")).toBe(
      "2026-08-30 10:00:00",
    );
  });

  test("an empty fetch leaves the watermark untouched", () => {
    expect(maxTs([], "2026-08-30 10:00:00")).toBe("2026-08-30 10:00:00");
  });
});

describe("state and allowlist I/O", () => {
  test("round-trips state", () => {
    const p = join(tmp(), "state.json");
    saveState({ watermark: "2026-08-30 10:00:00", readMark: "2026-08-30 09:00:00", readMarks: { A: "x" }, groups: {}, toasted: ["a"] }, p);
    expect(loadState(p)).toEqual({
      watermark: "2026-08-30 10:00:00",
      readMark: "2026-08-30 09:00:00",
      readMarks: { A: "x" },
      groups: {},
      toasted: ["a"],
    });
  });

  test("a missing state file yields a safe empty watermark", () => {
    expect(loadState(join(tmp(), "nope.json"))).toEqual({ watermark: "", readMark: "", readMarks: {}, groups: {}, toasted: [] });
  });

  test("corrupt state does not throw", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{ this is not json");
    expect(loadState(p)).toEqual({ watermark: "", readMark: "", readMarks: {}, groups: {}, toasted: [] });
  });

  test("the toast ring is capped so the state file cannot grow forever", () => {
    const p = join(tmp(), "big.json");
    saveState({ watermark: "x", readMark: "x", readMarks: {}, groups: {}, toasted: Array.from({ length: 500 }, (_, i) => `k${i}`) }, p);
    expect(loadState(p).toasted).toHaveLength(200);
  });

  test("a pre-two-mark state file inherits readMark from watermark", () => {
    // Migration guard: an old {watermark, toasted} file must report zero unread,
    // not a fabricated backlog, the first time the new collector reads it.
    const p = join(tmp(), "legacy.json");
    writeFileSync(p, JSON.stringify({ watermark: "2026-08-30 10:00:00", toasted: [] }));
    expect(loadState(p).readMark).toBe("2026-08-30 10:00:00");
    expect(loadState(p).readMarks).toEqual({});
  });

  test("reads a bare-array allowlist", () => {
    const p = join(tmp(), "allow.json");
    writeFileSync(p, JSON.stringify(["+15551234567"]));
    expect(loadAllowlist(p)).toEqual(["+15551234567"]);
  });

  test("reads an {allow:[...]} allowlist", () => {
    const p = join(tmp(), "allow2.json");
    writeFileSync(p, JSON.stringify({ allow: ["+15551234567"], note: "ignored" }));
    expect(loadAllowlist(p)).toEqual(["+15551234567"]);
  });

  test("a missing allowlist is empty, not an error", () => {
    expect(loadAllowlist(join(tmp(), "none.json"))).toEqual([]);
  });

  test("non-string entries are filtered out", () => {
    const p = join(tmp(), "mixed.json");
    writeFileSync(p, JSON.stringify(["+15551234567", 42, null]));
    expect(loadAllowlist(p)).toEqual(["+15551234567"]);
  });
});

describe("fetchMessages", () => {
  const fake = (r: { status: number; stdout?: string; stderr?: string }) =>
    (() => ({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })) as never;

  test("parses a good response", () => {
    const r = fetchMessages(10, fake({ status: 0, stdout: JSON.stringify([msg()]) }));
    expect(r.ok).toBe(true);
    expect(r.online).toBe(true);
    expect(r.msgs).toHaveLength(1);
  });

  test("exit 69 reports fnix offline, not a crash", () => {
    // 69 = EX_UNAVAILABLE, the documented code from the imsg shim's reachability guard.
    const r = fetchMessages(10, fake({ status: 69 }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
    expect(r.error).toBe("fnix unreachable");
  });

  test("a non-zero exit surfaces the first stderr line", () => {
    const r = fetchMessages(10, fake({ status: 1, stderr: "boom\nsecond line" }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(true);
    expect(r.error).toBe("boom");
  });

  test("malformed stdout is reported, not thrown", () => {
    const r = fetchMessages(10, fake({ status: 0, stdout: "not json at all" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
  });

  test("a JSON object instead of an array is rejected", () => {
    const r = fetchMessages(10, fake({ status: 0, stdout: '{"oops":true}' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
  });
});

describe("fetchGroups", () => {
  const fake = (r: { status: number; stdout?: string }) =>
    (() => ({ status: r.status, stdout: r.stdout ?? "", stderr: "" })) as never;
  test("parses sqlite -json rows into a map", () => {
    const g = fetchGroups(fake({ status: 0, stdout: JSON.stringify([{ chat: "abc", guid: "any;+;abc", name: "LMT", participants: "+1,+2" }]) }));
    expect(g).toEqual({ abc: { name: "LMT", guid: "any;+;abc", participants: ["+1", "+2"] } });
  });
  test("a failed lookup returns null so the cached copy is kept", () => {
    expect(fetchGroups(fake({ status: 69 }))).toBeNull();
    expect(fetchGroups(fake({ status: 0, stdout: "junk" }))).toBeNull();
  });
});
