import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The shim hands the Mac one command line; blip-dispatch (and a login shell on
// the general-key path) splits it with shlex. `${*@Q}` rendered an argument that
// held a control character as $'a\tb', which shlex does not understand, so the
// argument was garbled and one that also held an apostrophe injected extra
// arguments into imsg-send. A fake ssh records the line; python's shlex is the
// parser the Mac uses.
describe("blip-shim: every argument survives the remote shlex.split intact", () => {
  const shim = new URL("./bridge/linux/blip-shim", import.meta.url).pathname;

  function remoteArgs(args: string[]): string[] {
    const dir = mkdtempSync(join(tmpdir(), "blip-quoting-"));
    copyFileSync(shim, join(dir, "imsg-send"));
    chmodSync(join(dir, "imsg-send"), 0o755);
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/ssh.log"\n`);
    chmodSync(join(dir, "ssh"), 0o755);
    writeFileSync(join(dir, "bridge.conf"), `host=mac.example\nkey=${dir}/no-key\n`);
    spawnSync(join(dir, "imsg-send"), args, {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, BLIP_BRIDGE_CONF: join(dir, "bridge.conf") },
    });
    const log = existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    const py = spawnSync("python3", ["-I", "-c",
      "import shlex,sys,json; t=shlex.split(sys.stdin.read()); "
      + "i=max(k for k,v in enumerate(t) if v.endswith('/imsg-send')); print(json.dumps(t[i+1:]))"],
      { input: log, encoding: "utf8" });
    return JSON.parse(py.stdout);
  }

  test.each([
    ["a tab", "a\tb.png"],
    ["a newline", "x\ny.png"],
    ["an apostrophe", "it's.png"],
    ["an injected option after an apostrophe", "q' --to +15550100001 '.png"],
    ["a leading dash", "-scan.png"],
    ["shell metacharacters", 'a"b$c`d;e|f.png'],
    ["an empty value", ""],
  ])("%s", (_label, name) => {
    expect(remoteArgs(["--file-stdin", "--name", name])).toEqual(["--file-stdin", "--name", name]);
  });

  test("no arguments is no arguments", () => {
    expect(remoteArgs([])).toEqual([]);
  });
});
