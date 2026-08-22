import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inheritedEnvironment = { ...process.env };
try {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "gakuniku-startup-"));
  fs.rmSync(probe, { recursive: true, force: true });
} catch {
  const fallbackTempRoot = path.join(projectRoot, ".precision-subtitle-studio", "tmp");
  fs.mkdirSync(fallbackTempRoot, { recursive: true });
  inheritedEnvironment.TMPDIR = fallbackTempRoot;
  inheritedEnvironment.TEMP = fallbackTempRoot;
  inheritedEnvironment.TMP = fallbackTempRoot;
}
const bridge = spawn(process.execPath, [path.join(projectRoot, "local-agent-bridge", "server.mjs")], {
  cwd: projectRoot,
  env: inheritedEnvironment,
  stdio: "inherit",
});
const vinext = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
const web = spawn(vinext, ["dev"], {
  cwd: projectRoot,
  env: inheritedEnvironment,
  stdio: "inherit",
  windowsHide: true,
  detached: process.platform !== "win32",
});

web.on("error", (error) => {
  console.error(`无法启动界面开发服务：${error.message}。请先在项目目录安装前端依赖。`);
  if (!bridge.killed) bridge.kill("SIGTERM");
});

function stopWeb(signal) {
  if (!web.killed && web.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(web.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    else {
      try { process.kill(-web.pid, signal); } catch { web.kill(signal); }
    }
  }
}

function stop(signal) {
  if (!bridge.killed) bridge.kill(signal);
  stopWeb(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
bridge.on("exit", () => {
  stopWeb("SIGTERM");
});
web.on("exit", (code) => {
  if (!bridge.killed) bridge.kill("SIGTERM");
  process.exitCode = code ?? 0;
});
