import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = spawn(process.execPath, [path.join(projectRoot, "local-agent-bridge", "server.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
});
const web = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
  cwd: projectRoot,
  stdio: "inherit",
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
