import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowlist, selectToasts, unreadCounts, type ImsgMessage } from "./collector";
import { MAX_TOAST_REQUEST_BYTES, readToastRequest, toastAllowlistRequest } from "./toast-allowlist";

const chat = "+15551234567";
const handle = "person@example.com";
const other = "+15551234568";
const set = { action: "set", chat, handle, enabled: true };
let home: string;
let path: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "blip-toast-policy-"));
  path = join(home, ".config/blip/allowlist.json");
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
function seed(value: unknown): void {
  mkdirSync(join(home, ".config/blip"), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("desktop-toast allowlist", () => {
  test("missing file loads empty and disabling does not create it", () => {
    expect(toastAllowlistRequest({ action: "load" }, path)).toEqual({ ok: true, allow: [] });
    expect(toastAllowlistRequest({ ...set, enabled: false }, path)).toEqual({ ok: true, allow: [] });
    expect(existsSync(path)).toBe(false);
  });

  test("adds the chat, stays idempotent, and removes it without deleting the file", () => {
    expect(toastAllowlistRequest(set, path)).toEqual({ ok: true, allow: [chat] });
    const first = statSync(path);
    expect(toastAllowlistRequest(set, path)).toEqual({ ok: true, allow: [chat] });
    expect(statSync(path).ino).toBe(first.ino);
    expect(toastAllowlistRequest({ ...set, enabled: false }, path)).toEqual({ ok: true, allow: [] });
    const empty = statSync(path);
    expect(toastAllowlistRequest({ ...set, enabled: false }, path)).toEqual({ ok: true, allow: [] });
    expect(statSync(path).ino).toBe(empty.ino);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });

  test("existing exact handle enables a chat without adding another entry", () => {
    seed([handle, other]);
    const before = readFileSync(path, "utf8");
    expect(toastAllowlistRequest(set, path)).toEqual({ ok: true, allow: [handle, other] });
    expect(readFileSync(path, "utf8")).toBe(before);
    const message: ImsgMessage = {
      chat, handle, from_me: false, read: false, ts: "2026-08-30T11:00:00Z",
      name: null, service: "iMessage", text: "Synthetic fixture",
    };
    expect(selectToasts([message], "2026-08-30T10:00:00Z", loadAllowlist(path), [])).toHaveLength(1);
    expect(toastAllowlistRequest({ ...set, enabled: false }, path).ok).toBe(true);
    expect(selectToasts([message], "2026-08-30T10:00:00Z", loadAllowlist(path), [])).toEqual([]);
  });

  test("email chat keys remain exact, without case normalization", () => {
    seed(["PERSON@example.com"]);
    expect(toastAllowlistRequest({ ...set, chat: handle, handle }, path)).toEqual({
      ok: true, allow: ["PERSON@example.com", handle],
    });
    expect(toastAllowlistRequest({ ...set, chat: handle, handle, enabled: false }, path)).toEqual({
      ok: true, allow: ["PERSON@example.com"],
    });
  });

  test("disable removes every exact chat and handle entry, preserving unrelated array entries", () => {
    const ignored = { note: "kept" };
    seed([other, chat, handle, chat, "PERSON@example.com", chat + "0", 17, ignored]);
    expect(toastAllowlistRequest({ ...set, enabled: false }, path)).toEqual({
      ok: true, allow: [other, "PERSON@example.com", chat + "0"],
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([other, "PERSON@example.com", chat + "0", 17, ignored]);
  });

  test("preserves object metadata and ignored entries in both directions", () => {
    const metadata = { version: 2, nested: { future: true }, note: "preserve" };
    seed({ ...metadata, allow: [other, null, { extension: true }] });
    expect(toastAllowlistRequest(set, path)).toEqual({ ok: true, allow: [other, chat] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...metadata, allow: [other, null, { extension: true }, chat] });
    toastAllowlistRequest({ ...set, enabled: false }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...metadata, allow: [other, null, { extension: true }] });
  });

  test("load and set re-read external edits, preserving the latest unrelated entries", () => {
    seed([other]);
    expect(toastAllowlistRequest({ action: "load" }, path).allow).toEqual([other]);
    seed({ allow: [handle, "external@example.com"], revision: 3 });
    expect(toastAllowlistRequest({ action: "load" }, path).allow).toEqual([handle, "external@example.com"]);
    expect(toastAllowlistRequest({ ...set, enabled: false }, path).allow).toEqual(["external@example.com"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ allow: ["external@example.com"], revision: 3 });
  });

  test("malformed JSON and unsupported shapes fail without clobbering any bytes", () => {
    seed([]);
    for (const text of ["{broken", "null", '"value"', "{}", '{"allow":"wrong","note":1}']) {
      writeFileSync(path, text);
      for (const request of [{ action: "load" }, set, { ...set, enabled: false }]) {
        const reply = toastAllowlistRequest(request, path);
        expect(reply.ok).toBe(false);
        expect(reply.allow).toEqual([]);
        expect(reply.error).toBeTruthy();
        expect(readFileSync(path, "utf8")).toBe(text);
      }
    }
  });

  test("group and unknown chat ids never modify their latest sender's permission", () => {
    seed([handle, other]);
    for (const group of ["chat12345", "a".repeat(32), "any;+;chat12345", "unknown", ""]) {
      for (const enabled of [true, false]) {
        const reply = toastAllowlistRequest({ ...set, chat: group, enabled }, path);
        expect(reply.ok).toBe(false);
        expect(reply.allow).toEqual([handle, other]);
        expect(loadAllowlist(path)).toEqual([handle, other]);
      }
    }
  });

  test("invalid protocol fields cannot write config", () => {
    for (const request of [null, [], {}, { action: "delete" }, { ...set, enabled: "true" },
      { ...set, chat: 1 }, { ...set, handle: null }, { ...set, chat: chat + "\n" }]) {
      expect(toastAllowlistRequest(request, path).ok).toBe(false);
      expect(existsSync(path)).toBe(false);
    }
  });

  test("writes private files by atomic replacement and leaves no temporary files", () => {
    expect(toastAllowlistRequest(set, path).ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config/blip")).mode & 0o777).toBe(0o700);
    const before = statSync(path).ino;
    expect(toastAllowlistRequest({ ...set, chat: other, handle: other }, path).ok).toBe(true);
    expect(statSync(path).ino).not.toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, ".config/blip"))).toEqual(["allowlist.json"]);
    expect(loadAllowlist(path)).toEqual([chat, other]);
  });

  test("persisted policy changes toast selection, not unread counts or unrelated senders", () => {
    const watermark = "2026-08-30T10:00:00Z";
    const messages: ImsgMessage[] = [chat, other].map(id => ({
      chat: id, handle: id === chat ? handle : id, from_me: false, read: false,
      ts: "2026-08-30T11:00:00Z", name: null, service: "iMessage", text: "Synthetic fixture",
    }));
    const original = structuredClone(messages);
    const unread = unreadCounts(messages, watermark, {});
    expect(unread).toEqual({ [chat]: 1, [other]: 1 });
    seed([other]);
    expect(selectToasts(messages, watermark, loadAllowlist(path), []).map(t => t.chat)).toEqual([other]);
    expect(toastAllowlistRequest(set, path).ok).toBe(true);
    expect(selectToasts(messages, watermark, loadAllowlist(path), []).map(t => t.chat)).toEqual([chat, other]);
    expect(unreadCounts(messages, watermark, {})).toEqual(unread);
    expect(toastAllowlistRequest({ ...set, enabled: false }, path).ok).toBe(true);
    expect(selectToasts(messages, watermark, loadAllowlist(path), []).map(t => t.chat)).toEqual([other]);
    expect(unreadCounts(messages, watermark, {})).toEqual(unread);
    expect(messages).toEqual(original);
  });

  test("CLI exchanges one JSON reply using sandbox HOME, without collector execution", () => {
    for (const request of [{ action: "load" }, set, { ...set, enabled: false }]) {
      const result = spawnSync(process.execPath, [join(import.meta.dir, "toast-allowlist.ts")], {
        env: { ...process.env, HOME: home }, input: JSON.stringify(request), encoding: "utf8", timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const reply = JSON.parse(result.stdout);
      expect(reply).toEqual({ ok: true, allow: request === set ? [chat] : [] });
    }
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });
});

test("stdin protocol rejects invalid, multiple, and oversized JSON documents", async () => {
  async function* input(text: string) { yield text; }
  expect(await readToastRequest(input('{"action":"load"}\n'))).toEqual({ action: "load" });
  await expect(readToastRequest(input("{"))).rejects.toThrow("valid JSON");
  await expect(readToastRequest(input('{}\n{}'))).rejects.toThrow("valid JSON");
  await expect(readToastRequest(input(" ".repeat(MAX_TOAST_REQUEST_BYTES + 1)))).rejects.toThrow("too large");
  await expect(readToastRequest(input("é".repeat(MAX_TOAST_REQUEST_BYTES / 2 + 1)))).rejects.toThrow("too large");
});
