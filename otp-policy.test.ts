import { test, expect } from "bun:test";
import { classify, OtpState, validTarget, type DesktopTarget } from "./otp-policy";
import { selectCodes, extractCode } from "./collector";
const target = (field: any = {}): DesktopTarget => ({ id: "focus-1", window: "0xabc", pid: 100, browser: true, monitor: "DP-1",
  field: { tag: "input", type: "text", label: "Verification code", autocomplete: "", multiline: false,
    editable: true, empty: true, maxLength: 6, web: true, origin: "https://example.test", ...field } });
const code = (more = {}) => ({ code: "012345", domain: "", key: "code:sha256:" + "a".repeat(64), remainingMs: 300000, ...more });
function setup() {
  let now = 1; const out: any[] = [];
  const state = new OtpState(e => out.push(e), () => now);
  return { state, out, advance: (n: number) => { now += n; state.tick(); } };
}
test("OS metadata identifies OTP without declarations and rejects known unrelated fields", () => {
  expect(classify(target())).toBe("smart");
  expect(classify(target({ label: "", autocomplete: "one-time-code" }))).toBe("smart");
  for (const f of [{ label: "Message ChatGPT" }, { label: "Search" }, { label: "Phone number", type: "tel" },
    { label: "Password", type: "password" }, { tag: "textarea" }, { tag: "div" }, { multiline: true },
    { empty: false }, { editable: false }, { web: false }, { label: "Security code", autocomplete: "cc-csc" }]) expect(classify(target(f))).toBeNull();
  expect(classify(target({ label: "Code" }))).toBe("manual");
  expect(classify({ ...target(), field: undefined })).toBe("manual");
  expect(classify({ ...target(), browser: false, field: undefined })).toBeNull();
});
test("native GTK fields use the same smart policy while browser address bars are excluded", () => {
  expect(classify({ ...target({ tag: "native", web: false }), browser: false })).toBe("smart");
  expect(classify(target({ tag: "native", web: false, label: "Address and search bar" }))).toBeNull();
});
test("focus change retains pending code, not the old offer; original expiry wins", () => {
  const s = setup(); s.state.focus(target()); s.state.publish(code());
  const first = s.out.at(-1); expect(first.type).toBe("offer");
  expect(JSON.stringify(first)).not.toContain("012345");
  s.state.focus(target({ label: "Ask anything" })); expect(s.out.at(-1).type).toBe("hide");
  s.advance(200000); s.state.focus({ ...target(), id: "focus-2" });
  expect(s.out.at(-1).deadline).toBe(300001);
  expect(s.state.accept(first.id)).toBeNull();
  s.advance(100000); expect(s.state.accept(s.out.at(-1).id)).toBeNull();
});
test("dismiss persists across focus changes and duplicate publications", () => {
  const s = setup(); s.state.focus(target()); s.state.publish(code()); s.state.dismiss(s.out.at(-1).id);
  s.state.focus({ ...target(), id: "other" }); s.state.publish(code());
  expect(s.out.at(-1).type).toBe("hide");
  s.state.publish(code({ key: "code:sha256:" + "b".repeat(64) })); expect(s.out.at(-1).type).toBe("offer");
});
test("only current one-use offer can insert; stale metadata and expiry refuse", () => {
  const s = setup(); s.state.focus(target()); s.state.publish(code()); const id = s.out.at(-1).id;
  expect(s.state.accept("wrong")).toBeNull();
  expect(s.state.accept(id)?.code).toBe("012345"); expect(s.state.accept(id)).toBeNull();
  const old = setup(); old.state.focus(target()); old.state.publish(code()); const oldId = old.out.at(-1).id;
  old.advance(1600); expect(old.state.accept(oldId)).toBeNull();
});
test("domain-bound messages require the exact native accessibility document origin", () => {
  for (const origin of ["http://example.test", "https://evil.example.test", "https://example.test.evil.test", ""]) {
    const s = setup(); s.state.focus(target({ origin })); s.state.publish(code({ domain: "example.test" })); expect(s.out).toHaveLength(0);
  }
  const s = setup(); s.state.focus(target()); s.state.publish(code({ domain: "example.test" })); expect(s.out.at(-1).type).toBe("offer");
  const unknown = setup(); unknown.state.focus({ ...target(), field: undefined }); unknown.state.publish(code({ domain: "example.test" })); expect(unknown.out).toHaveLength(0);
});
test("invalid metadata fails closed", () => {
  expect(validTarget({ ...target(), window: '0xabc";evil()' })).toBe(false);
  expect(validTarget(target({ label: "x".repeat(161) }))).toBe(false);
});
test("installed-version collector selects synthetic SMS/iMessage and preserves opaque dedupe", () => {
  for (const service of ["SMS", "iMessage"]) {
    const message = { id: "synthetic", ts: "2026-01-01 12:00:01", from_me: false,
      handle: "+15551234567", chat: "+15551234567", name: null, service, text: "Your verification code is 012345" };
    const at = Date.parse("2026-01-01 12:00:30");
    const codes = selectCodes([message], "2026-01-01 12:00:00", [], [], at);
    expect(codes).toHaveLength(1);
    // Hours later (a long suspend): the code is past its five minutes and is never offered.
    expect(selectCodes([message], "2026-01-01 12:00:00", [], [], at + 3 * 3600_000)).toHaveLength(0);
    const s = setup(); s.state.focus(target()); s.state.publish({ ...codes[0], remainingMs: 300000 });
    expect(s.out.at(-1).type).toBe("offer");
    expect(selectCodes([message], "2026-01-01 12:00:00", [codes[0]!.key], [], at)).toHaveLength(0);
    expect(selectCodes([message], "", [], [], at)).toHaveLength(0);
  }
  expect(extractCode("Your security code for card 1234 is 987654")?.code).toBe("987654");
  expect(extractCode("Call +1 (555) 010-0199")).toBeNull();
});

test("field geometry is bounded, follows the field, and invalidates an old click target", () => {
  const s = setup(); const first = { ...target(), anchor: { x: 40, y: 100, w: 200, h: 32 } };
  s.state.focus(first); s.state.publish(code()); const offer = s.out.at(-1);
  expect(offer.anchor).toEqual(first.anchor);
  s.state.focus({ ...first, anchor: { ...first.anchor, y: 160 } });
  expect(s.out.at(-1).anchor.y).toBe(160);
  expect(s.state.accept(offer.id)).toBeNull();
  expect(validTarget({ ...first, anchor: { ...first.anchor, x: Infinity } })).toBe(false);
  expect(validTarget({ ...first, anchor: { ...first.anchor, w: -1 } })).toBe(false);
});

test("digit groups require a complete empty group matching the code length", () => {
  const group = { ...target({ type: "tel", maxLength: 1, label: "Please enter OTP character 1" }),
    segments: { count: 6, index: 0, empty: true } };
  expect(validTarget(group)).toBe(true);
  expect(classify(group)).toBe("smart");
  const s = setup(); s.state.focus(group); s.state.publish(code());
  expect(s.state.accept(s.out.at(-1).id)?.target.segments).toEqual(group.segments);
  for (const segments of [{ count: 5, index: 0, empty: true }, { count: 6, index: 0, empty: false }]) {
    const refused = setup(); refused.state.focus({ ...group, segments }); refused.state.publish(code());
    expect(refused.out).toHaveLength(0);
  }
  for (const segments of [{ count: 13, index: 0, empty: true }, { count: 6, index: 6, empty: true }, { count: 6, index: 0, empty: "yes" }]) {
    expect(validTarget({ ...group, segments })).toBe(false);
  }
  expect(classify({ ...group, segments: undefined })).toBeNull();
  expect(classify({ ...group, field: { ...group.field!, label: "Phone number" } })).toBeNull();
  expect(classify({ ...group, field: { ...group.field!, maxLength: -1 } })).toBe("smart");
});
