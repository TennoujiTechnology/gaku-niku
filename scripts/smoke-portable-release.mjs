import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const packageArgument = process.argv.slice(2).find((argument) => argument !== "--");
const packageRoot = path.resolve(packageArgument || "");
if (!packageArgument || packageRoot === path.parse(packageRoot).root) {
  throw new Error("用法：node scripts/smoke-portable-release.mjs <已解压的发行目录>");
}

const windows = process.platform === "win32";
const bundledNode = path.join(packageRoot, "runtime", "node", windows ? "node.exe" : "bin/node");
const server = path.join(packageRoot, "local-agent-bridge", "server.mjs");
for (const file of [bundledNode, server, path.join(packageRoot, "standalone", "index.html")]) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`发行文件缺失：${file}`);
}

const version = spawnSync(bundledNode, ["--version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== "v22.14.0") {
  throw new Error(`内置 Node 无法执行：${version.stderr || version.stdout}`);
}

const smokeRoot = path.join(packageRoot, "data", "smoke-test");
await mkdir(smokeRoot, { recursive: true });
const port = 44000 + (process.pid % 1000);
const child = spawn(bundledNode, [server], {
  cwd: packageRoot,
  env: {
    ...process.env,
    PSS_BRIDGE_PORT: String(port),
    PSS_JOBS_PATH: path.join(smokeRoot, "jobs"),
    PSS_ASR_ROOT: path.join(smokeRoot, "asr"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`后端提前退出：${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Continue until the startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!health) throw new Error(`后端未在 20 秒内就绪：${output}`);
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const page = await pageResponse.text();
  if (!pageResponse.ok || !page.includes("root")) throw new Error("发行版首页无法读取");
  const capabilitiesResponse = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
  if (!capabilitiesResponse.ok) throw new Error("能力接口无法读取");
  const releaseNotes = await readFile(path.join(packageRoot, "RELEASE_NOTES.md"), "utf8");
  if (!releaseNotes.includes("v0.2.0")) throw new Error("发行说明版本不匹配");
  process.stdout.write(`便携版冒烟测试通过：Node ${version.stdout.trim()}，后端、首页与能力接口均可用\n`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
}
