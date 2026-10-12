/** Bundled Blip helper. Only inherited private pipes carry codes; no socket API. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { OtpState } from "./otp-policy";
export class Frames {
  private buffer = Buffer.alloc(0);
  feed(chunk: Buffer, accept: (event: any) => void) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
      if (this.buffer.length + i - start > 4096) throw new Error("frame limit");
      const line = Buffer.concat([this.buffer, chunk.subarray(start, i)]); this.buffer = Buffer.alloc(0);
      accept(JSON.parse(line.toString())); start = i + 1;
    }
    if (this.buffer.length + chunk.length - start > 4096) throw new Error("frame limit");
    this.buffer = Buffer.concat([this.buffer, chunk.subarray(start)]);
  }
}
if (import.meta.main) {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const key of ["HOME", "XDG_RUNTIME_DIR", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_SESSION_ID", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "LANG"])
    if (process.env[key]) env[key] = process.env[key];
  const desktop = spawn("/usr/bin/python3", ["-I", join(import.meta.dir, "otp-desktop.py")], { env, stdio: ["pipe", "pipe", "ignore"] });
  let stopping = false;
  const emit = (e: any) => {
    if (process.stdout.writableLength > 16384) return stop();
    process.stdout.write(JSON.stringify(e) + "\n");
  };
  const state = new OtpState(emit);
  const timer = setInterval(() => state.tick(), 200);
  const stop = () => {
    if (stopping) return; stopping = true;
    clearInterval(timer); state.clear(); desktop.stdin.end();
    if (desktop.exitCode !== null || desktop.signalCode !== null) process.exit(0);
    desktop.kill("SIGTERM");
    const kill = setTimeout(() => desktop.kill("SIGKILL"), 1000);
    desktop.once("exit", () => { clearTimeout(kill); process.exit(0); });
  };
  const input = new Frames(), output = new Frames();
  process.stdin.on("data", b => { try { input.feed(b, e => {
    if (e.type === "code") state.publish(e);
    else if (e.type === "dismiss") state.dismiss(e.id);
    else if (e.type === "accept") {
      const fill = state.accept(e.id);
      if (fill && desktop.stdin.writableLength < 16384) desktop.stdin.write(JSON.stringify(fill) + "\n");
    }
  }); } catch { stop(); } });
  desktop.stdout.on("data", b => { try { output.feed(b, e => {
    if (e.type === "focus") state.focus(e.target);
    else if (e.type === "ready") emit({ type: "ready" });
  }); } catch { stop(); } });
  desktop.on("exit", stop); desktop.on("error", stop); desktop.stdin.on("error", stop);
  process.stdin.on("end", stop); process.stdout.on("error", stop);
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
