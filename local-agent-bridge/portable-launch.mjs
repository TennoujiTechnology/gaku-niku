import { spawn } from "node:child_process";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridgeDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(bridgeDirectory, "..");
const port = Number(process.env.PSS_BRIDGE_PORT || 43127);
const appUrl = `http://127.0.0.1:${port}/`;
const healthUrl = `http://127.0.0.1:${port}/api/health`;

function healthReady(timeoutMs = 700) {
  return new Promise((resolve) => {
    const probe = request(healthUrl, { method: "GET", timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    probe.on("timeout", () => { probe.destroy(); resolve(false); });
    probe.on("error", () => resolve(false));
    probe.end();
  });
}

function openBrowser() {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", `start "" "${appUrl}"`] : [appUrl];
  const opener = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  opener.unref();
}

async function waitForBridge(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) return false;
    if (await healthReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

if (await healthReady()) {
  process.stdout.write(`GakuNiku 已在运行：${appUrl}\n`);
  openBrowser();
  process.exit(0);
}

const environment = {
  ...process.env,
  PSS_JOBS_PATH: process.env.PSS_JOBS_PATH || path.join(projectRoot, "data", "jobs"),
  PSS_ASR_ROOT: process.env.PSS_ASR_ROOT || path.join(projectRoot, "data", "asr"),
};
const bridge = spawn(process.execPath, [path.join(bridgeDirectory, "server.mjs")], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
  windowsHide: false,
});

const ready = await waitForBridge(bridge);
if (!ready) {
  if (bridge.exitCode === null) bridge.kill("SIGTERM");
  process.stderr.write("GakuNiku 后端未能在 20 秒内启动，请保留此窗口中的错误信息。\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`GakuNiku 已启动：${appUrl}\n关闭此窗口即可停止本地后端。\n`);
  openBrowser();
}

function stop(signal) {
  if (bridge.exitCode === null && !bridge.killed) bridge.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
bridge.on("exit", (code) => { process.exitCode = code ?? 0; });
