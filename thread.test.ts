import { describe, expect, test } from "bun:test";

import type { ImsgMessage } from "./collector";
import {
  clockLabel,
  dayLabel,
  decorate,
  dedupeSelfEcho,
  loadThread,
  localToday,
  minutesBetween,
  selectThread,
} from "./thread";

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

describe("clockLabel", () => {
  test("formats afternoon as 12-hour with PM", () => {
    expect(clockLabel("2026-08-30 21:08:22")).toBe("9:08 PM");
  });

  test("formats morning as AM", () => {
    expect(clockLabel("2026-08-30 09:05:00")).toBe("9:05 AM");
  });

  test("midnight is 12 AM, not 0 AM", () => {
    expect(clockLabel("2026-08-30 00:30:00")).toBe("12:30 AM");
  });

  test("noon is 12 PM, not 0 PM", () => {
    expect(clockLabel("2026-08-30 12:00:00")).toBe("12:00 PM");
  });

  test("garbage in yields an empty label, not a crash", () => {
    expect(clockLabel("nonsense")).toBe("");
  });
});

describe("dayLabel", () => {
  const today = "2026-08-30";

  test("same date reads Today", () => {
    expect(dayLabel("2026-08-30 09:00:00", today)).toBe("Today");
  });

  test("one day back reads Yesterday", () => {
    expect(dayLabel("2026-08-29 09:00:00", today)).toBe("Yesterday");
  });

  test("earlier this year omits the year", () => {
    expect(dayLabel("2026-08-28 09:00:00", today)).toBe("Aug 28");
  });

  test("a previous year includes it", () => {
    expect(dayLabel("2025-12-24 09:00:00", today)).toBe("Dec 24, 2025");
  });

  test("crossing a month boundary still resolves Yesterday", () => {
    expect(dayLabel("2026-07-31 09:00:00", "2026-08-01")).toBe("Yesterday");
  });

  test("malformed input yields an empty label", () => {
    expect(dayLabel("not-a-date", today)).toBe("");
  });
});

describe("minutesBetween", () => {
  test("measures a simple gap", () => {
    expect(minutesBetween("2026-08-30 12:00:00", "2026-08-30 12:20:00")).toBe(20);
  });

  test("is order-independent", () => {
    expect(minutesBetween("2026-08-30 12:20:00", "2026-08-30 12:00:00")).toBe(20);
  });

  test("unparseable stamps read as infinitely far apart, forcing a new group", () => {
    expect(minutesBetween("junk", "2026-08-30 12:00:00")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("decorate", () => {
  const today = "2026-08-30";

  test("a lone message is both group start and end", () => {
    const b = decorate([msg({ ts: "2026-08-30 12:00:00" })], today);
    expect(b[0]!.groupStart).toBe(true);
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[0]!.time).toBe("12:00 PM");
  });

  test("consecutive messages from one sender form a single group", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30 12:00:00", text: "one" }),
        msg({ ts: "2026-08-30 12:01:00", text: "two" }),
        msg({ ts: "2026-08-30 12:02:00", text: "three" }),
      ],
      today,
    );
    expect(b.map((x) => x.groupStart)).toEqual([true, false, false]);
    expect(b.map((x) => x.groupEnd)).toEqual([false, false, true]);
  });

  test("only the last bubble of a group carries a timestamp", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30 12:00:00" }), msg({ ts: "2026-08-30 12:01:00" })],
      today,
    );
    expect(b[0]!.time).toBe("");
    expect(b[1]!.time).toBe("12:01 PM");
  });

  test("a sender change breaks the group", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30 12:00:00", from_me: false }),
        msg({ ts: "2026-08-30 12:01:00", from_me: true }),
      ],
      today,
    );
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[1]!.groupStart).toBe(true);
  });

  test("in a group, a different member breaks the run even seconds apart", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-30 12:00:00", handle: "+1111111111", name: "Craig" }),
        msg({ ts: "2026-08-30 12:00:30", handle: "+2222222222", name: "Scott" }),
      ],
      today,
    );
    expect(b[0]!.groupEnd).toBe(true);
    expect(b[1]!.groupStart).toBe(true);
  });

  test("a gap longer than 15 minutes breaks the group", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30 12:00:00" }), msg({ ts: "2026-08-30 12:20:00" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(true);
  });

  test("a gap under 15 minutes does not", () => {
    const b = decorate(
      [msg({ ts: "2026-08-30 12:00:00" }), msg({ ts: "2026-08-30 12:14:00" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(false);
  });

  test("the day label appears once, on the first message of that day", () => {
    const b = decorate(
      [
        msg({ ts: "2026-08-29 23:00:00" }),
        msg({ ts: "2026-08-30 09:00:00" }),
        msg({ ts: "2026-08-30 09:01:00" }),
      ],
      today,
    );
    expect(b[0]!.day).toBe("Yesterday");
    expect(b[1]!.day).toBe("Today");
    expect(b[2]!.day).toBe("");
  });

  test("a day change always starts a new group even within 15 minutes", () => {
    const b = decorate(
      [msg({ ts: "2026-08-29 23:59:00" }), msg({ ts: "2026-08-30 00:01:00" })],
      today,
    );
    expect(b[1]!.groupStart).toBe(true);
    expect(b[0]!.groupEnd).toBe(true);
  });

  test("falls back to the handle when a message has no contact name", () => {
    const b = decorate([msg({ name: null, handle: "+15551234567" })], today);
    expect(b[0]!.name).toBe("+15551234567");
  });

  test("an empty thread decorates to nothing", () => {
    expect(decorate([], today)).toEqual([]);
  });
});

describe("dedupeSelfEcho", () => {
  test("drops the empty from_me twin the self-thread produces", () => {
    // A real send logs twice: from_me=true with empty text, and from_me=false
    // carrying the text. Rendering both shows your own message as theirs.
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "Larry test" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Larry test");
  });

  test("the surviving twin is re-attributed to me — it renders on the right", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "mine" }),
    ]);
    expect(out[0]!.from_me).toBe(true);
  });

  test("a text-bearing pair is mine whichever twin arrives first", () => {
    // imsg decodes attributedBody, so the from_me=true twin has text too.
    const a = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "same" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "same" }),
    ]);
    expect(a).toHaveLength(1);
    expect(a[0]!.from_me).toBe(true);
    const b = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", from_me: true, text: "same" }),
      msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "same" }),
    ]);
    expect(b[0]!.from_me).toBe(true);
  });

  test("a genuine inbound with no empty twin stays theirs", () => {
    const out = dedupeSelfEcho([msg({ ts: "2026-08-30 21:08:22", from_me: false, text: "theirs" })]);
    expect(out[0]!.from_me).toBe(false);
  });

  test("collapses exact duplicates at the same timestamp", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", text: "same" }),
      msg({ ts: "2026-08-30 21:08:22", text: "same" }),
    ]);
    expect(out).toHaveLength(1);
  });

  test("keeps identical text sent at different times", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 21:08:22", text: "ok" }),
      msg({ ts: "2026-08-30 21:09:00", text: "ok" }),
    ]);
    expect(out).toHaveLength(2);
  });

  test("leaves an ordinary conversation untouched", () => {
    const out = dedupeSelfEcho([
      msg({ ts: "2026-08-30 12:00:00", text: "hi" }),
      msg({ ts: "2026-08-30 12:01:00", from_me: true, text: "hey" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("loadThread", () => {
  const fake = (r: { status: number; stdout?: string; stderr?: string }) =>
    (() => ({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })) as never;

  test("returns decorated bubbles on success", () => {
    const r = loadThread(
      "+15551234567",
      10,
      "2026-08-30",
      fake({ status: 0, stdout: JSON.stringify([msg({ ts: "2026-08-30 12:00:00" })]) }),
    );
    expect(r.ok).toBe(true);
    expect(r.bubbles).toHaveLength(1);
    expect(r.bubbles[0]!.time).toBe("12:00 PM");
  });

  test("exit 69 reports the bridge offline", () => {
    const r = loadThread("+1", 10, "2026-08-30", fake({ status: 69 }));
    expect(r.ok).toBe(false);
    expect(r.online).toBe(false);
    expect(r.error).toBe("fnix unreachable");
  });

  test("malformed stdout is reported, not thrown", () => {
    const r = loadThread("+1", 10, "2026-08-30", fake({ status: 0, stdout: "junk" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad JSON");
  });

  test("a non-zero exit surfaces the first stderr line", () => {
    const r = loadThread("+1", 10, "2026-08-30", fake({ status: 2, stderr: "nope\nmore" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nope");
  });
});

describe("localToday", () => {
  test("uses the local calendar date, not UTC", () => {
    // 2026-08-30 23:30 local — toISOString() would already say the 31st in EDT.
    expect(localToday(new Date(2026, 7, 30, 23, 30))).toBe("2026-08-30");
  });

  test("zero-pads month and day", () => {
    expect(localToday(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("selectThread", () => {
  const guid = "ce5a593a78af408282d61461ade89135";
  test("a group filters a mixed recent window down to its own chat, oldest-first", () => {
    const out = selectThread(
      [
        msg({ chat: guid, ts: "2026-08-30 12:05:00", text: "late" }),
        msg({ chat: "+15550000000", ts: "2026-08-30 12:04:00", text: "other chat" }),
        msg({ chat: guid, ts: "2026-08-30 12:00:00", text: "early" }),
      ],
      guid, true, 80,
    );
    expect(out.map((m) => m.text)).toEqual(["early", "late"]);
  });

  test("keeps only the newest `limit` messages", () => {
    const raw = Array.from({ length: 5 }, (_, i) => msg({ chat: guid, ts: `2026-08-30 12:0${i}:00`, text: `m${i}` }));
    expect(selectThread(raw, guid, true, 2).map((m) => m.text)).toEqual(["m3", "m4"]);
  });

  test("a DM window passes through untouched apart from ordering", () => {
    const out = selectThread([msg({ ts: "2026-08-30 12:01:00" }), msg({ ts: "2026-08-30 12:00:00" })], "+15551234567", false, 80);
    expect(out[0]!.ts).toBe("2026-08-30 12:00:00");
  });

  test("loadThread asks recent, not thread, for a group", () => {
    let seen: string[] = [];
    const runner = ((_: string, args: string[]) => { seen = args; return { status: 0, stdout: "[]", stderr: "" }; }) as never;
    loadThread(guid, 80, "2026-08-30", runner);
    expect(seen[1]).toBe("recent");
  });
});
