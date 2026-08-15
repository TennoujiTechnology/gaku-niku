import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = spawn(process.execPath, [path.join(projectRoot, "local-agent-bridge", "server.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
});
const vinext = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
const web = spawn(vinext, ["dev"], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true,
});

web.on("error", (error) => {
  console.error(`无法启动界面开发服务：${error.message}。请先在项目目录安装前端依赖。`);
  if (!bridge.killed) bridge.kill("SIGTERM");
});

function stop(signal) {
  if (!bridge.killed) bridge.kill(signal);
  if (!web.killed) web.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
bridge.on("exit", (code) => {
  if (code && !web.killed) web.kill("SIGTERM");
});
web.on("exit", (code) => {
  if (!bridge.killed) bridge.kill("SIGTERM");
  process.exitCode = code ?? 0;
});
