/** OS metadata policy. Never treat an arbitrary editable control as an OTP. */
export const TTL = 300000;
export interface DesktopTarget {
  id: string; window: string; pid: number; browser: boolean; monitor: string;
  anchor?: { x: number; y: number; w: number; h: number };
  segments?: { count: number; index: number; empty: boolean };
  field?: { tag: string; type: string; label: string; autocomplete: string; multiline: boolean;
    editable: boolean; empty: boolean; maxLength: number; web: boolean; origin: string; };
}
export function validTarget(t: any): t is DesktopTarget {
  return t && typeof t.id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(t.id)
    && typeof t.window === "string" && /^0x[a-f0-9]+$/.test(t.window)
    && Number.isSafeInteger(t.pid) && t.pid > 0 && typeof t.browser === "boolean"
    && typeof t.monitor === "string" && /^[a-zA-Z0-9_.:-]{0,64}$/.test(t.monitor)
    && (!t.segments || t.field?.web === true && t.field.tag === "input"
      && Number.isInteger(t.segments.count) && t.segments.count >= 4 && t.segments.count <= 12
      && Number.isInteger(t.segments.index) && t.segments.index >= 0 && t.segments.index < t.segments.count
      && typeof t.segments.empty === "boolean")
    && (!t.anchor || [t.anchor.x, t.anchor.y, t.anchor.w, t.anchor.h].every(n => Number.isSafeInteger(n) && Math.abs(n) <= 32768)
      && t.anchor.w > 0 && t.anchor.h > 0)
    && (!t.field || typeof t.field.label === "string" && t.field.label.length <= 160
      && typeof t.field.origin === "string" && t.field.origin.length <= 512
      && typeof t.field.autocomplete === "string" && t.field.autocomplete.length <= 100
      && typeof t.field.empty === "boolean" && typeof t.field.editable === "boolean"
      && typeof t.field.multiline === "boolean" && typeof t.field.web === "boolean"
      && ["input", "textarea", "div", "native", "other"].includes(t.field.tag)
      && ["text", "tel", "number", "password", "email", "search", "other"].includes(t.field.type)
      && Number.isInteger(t.field.maxLength) && t.field.maxLength >= -1 && t.field.maxLength <= 65536);
}
export function classify(t: DesktopTarget): "smart" | "manual" | null {
  const f = t.field;
  if (!f) return t.browser ? "manual" : null;
  if (!f.editable || !f.empty || f.multiline || !["input", "native"].includes(f.tag)
    || !["text", "tel", "number", "password"].includes(f.type)
    || t.segments && !t.segments.empty
    || !t.segments && f.maxLength !== -1 && f.maxLength < 4) return null;
  if (t.browser && !f.web) return null; // browser address/search bars are not page inputs
  const label = f.label.trim().replace(/\s+/g, " ").replace(/[:*]\s*$/, "");
  if (/\b(chat|message|ask|prompt|search|email|phone|card|cvv|cvc|password|zip|postal)\b/i.test(label)
    && !/^(sms|text message) code$/i.test(label)) return null;
  const tokens = f.autocomplete.toLowerCase().split(/\s+/);
  if (tokens.includes("one-time-code")) return "smart";
  if (tokens.some(x => x && x !== "on" && x !== "off" && !x.startsWith("section-"))) return null;
  if (t.segments && /^(?:please )?(?:enter )?(?:otp|verification code|authentication code|security code)(?: )?(?:digit|character) \d{1,2}$/i.test(label)) return "smart";
  if (/^(?:(?:enter|your|enter your|type|type your) )?(?:(?:one[ -]time|verification|authentication|authenticator|security|login|log[ -]in|sign[ -]in|2fa|two[ -]factor|sms|text message) (?:code|passcode)|otp)(?: \(\d[ -]digits?\)| \d[ -]digits?)?$/i.test(label)) return "smart";
  if (f.type === "password") return null;
  return t.browser ? "manual" : null;
}
export function domainMatches(domain: string, t: DesktopTarget): boolean {
  if (!domain) return true;
  try { const u = new URL(t.field?.origin || ""); return u.protocol === "https:" && u.hostname === domain; }
  catch { return false; }
}
export class OtpState {
  private pending?: { code: string; key: string; domain: string; deadline: number };
  private seen = new Map<string, number>();
  private target?: DesktopTarget;
  private offer?: { id: string; target: DesktopTarget; mode: "smart" | "manual" };
  private observed = 0;
  private unknownSince = 0;
  constructor(private emit: (e: any) => void, private now = () => Date.now()) {}
  publish(e: any) {
    this.tick();
    if (!e || typeof e.code !== "string" || !/^[a-zA-Z0-9-]{4,12}$/.test(e.code)
      || typeof e.key !== "string" || !/^code:sha256:[a-f0-9]{64}$/.test(e.key)
      || typeof e.domain !== "string" || e.domain.length > 253
      || e.domain && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(e.domain)
      || !Number.isFinite(e.remainingMs) || e.remainingMs <= 0 || this.seen.has(e.key) || this.seen.size >= 256) return;
    this.clear(); const deadline = this.now() + Math.min(TTL, e.remainingMs);
    this.pending = { code: e.code, key: e.key, domain: e.domain, deadline };
    this.seen.set(e.key, deadline); this.update();
  }
  focus(t: any) {
    this.observed = this.now();
    if (!validTarget(t)) { this.target = undefined; this.hide(); return; }
    if (this.target?.id !== t.id || JSON.stringify(this.target) !== JSON.stringify(t)) {
      this.hide(); this.unknownSince = this.now();
    }
    this.target = t; this.update();
  }
  private hide() { if (this.offer) this.emit({ type: "hide" }); this.offer = undefined; }
  clear() { this.pending = undefined; this.hide(); }
  private update() {
    const p = this.pending, t = this.target;
    const mode = t ? classify(t) : null;
    if (!p || !t || !mode || p.deadline <= this.now() || this.now() - this.observed > 1500
      || !t.field && this.now() - this.unknownSince < 500
      || t.segments && t.segments.count !== p.code.length
      || !t.segments && t.field && t.field.maxLength !== -1 && t.field.maxLength < p.code.length
      || t.field?.type === "number" && !/^\d+$/.test(p.code)
      || p.domain && !domainMatches(p.domain, t)) { this.hide(); return; }
    if (this.offer) return;
    this.offer = { id: crypto.randomUUID(), target: t, mode };
    this.emit({ type: "offer", id: this.offer.id, mode, monitor: t.monitor, anchor: t.anchor || null, deadline: p.deadline });
  }
  accept(id: unknown) {
    this.tick();
    if (!this.offer || !this.pending || this.offer.id !== id) return null;
    const result = { type: "fill", target: this.offer.target, mode: this.offer.mode, code: this.pending.code,
      deadline: Math.min(this.pending.deadline, this.now() + 1500) };
    this.clear(); return result;
  }
  dismiss(id: unknown) { if (this.offer?.id === id) this.clear(); }
  tick() {
    for (const [key, deadline] of this.seen) if (deadline <= this.now()) this.seen.delete(key);
    if (this.pending && this.pending.deadline <= this.now()) this.clear();
    if (this.now() - this.observed > 1500) this.hide();
    else this.update();
  }
}
