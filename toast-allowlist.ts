#!/usr/bin/env bun
/** Local desktop-toast policy only; no bridge, read-state, or Messages changes. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ALLOWLIST_PATH, isGroupChat } from "./collector";

export const MAX_TOAST_REQUEST_BYTES = 4096;
export interface ToastAllowlistReply { ok: boolean; allow: string[]; error?: string }
type AllowlistDocument = unknown[] | { allow: unknown[]; [key: string]: unknown };

function readDocument(path: string): AllowlistDocument {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read the desktop-toast allowlist");
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error("Desktop-toast allowlist is not valid JSON; file left unchanged"); }
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).allow))
    return raw as AllowlistDocument;
  // loadAllowlist deliberately fails closed; editing must instead refuse a bad shape.
  throw new Error("Desktop-toast allowlist must be an array or an object with an allow array; file left unchanged");
}
function writeDocument(path: string, document: AllowlistDocument): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(document, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, path);
  } catch {
    throw new Error("Could not save the desktop-toast allowlist; file left unchanged");
  } finally {
    try { unlinkSync(temp); } catch { /* Renamed successfully, or no temporary file was created. */ }
  }
}
function key(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 320 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}

/** Each request re-reads disk. The host serializes set requests. */
export function toastAllowlistRequest(value: unknown, path = ALLOWLIST_PATH): ToastAllowlistReply {
  let allow: string[] = [];
  try {
    const document = readDocument(path);
    const current = Array.isArray(document) ? document : document.allow;
    // Same filtering as collector.loadAllowlist; ignored entries remain on disk.
    allow = current.filter((entry): entry is string => typeof entry === "string");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Desktop-toast request must be a JSON object");
    const request = value as Record<string, unknown>;
    if (request.action === "load") return { ok: true, allow };
    if (request.action !== "set") throw new Error("Unknown desktop-toast action");
    const chat = key(request.chat, "chat");
    const handle = key(request.handle, "handle");
    if (!chat || isGroupChat(chat)) throw new Error("Desktop-toast controls are only available for direct phone or email chats");
    if (typeof request.enabled !== "boolean") throw new Error("enabled must be a boolean");
    const matches = (entry: unknown) => entry === chat || entry === handle;
    const next = request.enabled
      ? (current.some(matches) ? current : [...current, chat])
      : current.filter(entry => !matches(entry));
    // Idempotent operations do not rewrite files (or create a missing empty file).
    if (next.length !== current.length) {
      const updated = Array.isArray(document) ? next : { ...document, allow: next };
      writeDocument(path, updated);
      allow = next.filter((entry): entry is string => typeof entry === "string");
    }
    return { ok: true, allow };
  } catch (error) {
    return { ok: false, allow, error: error instanceof Error ? error.message : "Desktop-toast request failed" };
  }
}

/** One bounded JSON document, carried on stdin rather than shell arguments. */
export async function readToastRequest(input: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_TOAST_REQUEST_BYTES) throw new Error("Desktop-toast request is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw new Error("Desktop-toast request must be valid JSON"); }
}

if (import.meta.main) {
  const timer = setTimeout(() => {
    process.stdout.write(JSON.stringify({ ok: false, allow: [], error: "Desktop-toast request timed out" }) + "\n");
    process.exit(1);
  }, 5000);
  let reply: ToastAllowlistReply;
  try { reply = toastAllowlistRequest(await readToastRequest(process.stdin)); }
  catch (error) {
    reply = { ok: false, allow: [], error: error instanceof Error ? error.message : "Desktop-toast request failed" };
  }
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(reply) + "\n");
  if (!reply.ok) process.exitCode = 1;
}
