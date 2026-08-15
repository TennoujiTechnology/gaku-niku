import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseManifest = JSON.parse(await readFile(path.join(projectRoot, "release", "release-manifest.json"), "utf8"));
const runtimeManifest = JSON.parse(await readFile(path.join(projectRoot, "runtime", "runtime-manifest.json"), "utf8"));
const argumentsList = process.argv.slice(2);

function argumentValue(name, fallback) {
  const exact = argumentsList.find((item) => item.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : fallback;
}

const outputRoot = path.resolve(argumentValue("--output", path.join(projectRoot, "release", "portable")));
const requestedTargets = argumentValue("--target", "all")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const targets = requestedTargets.includes("all") ? Object.keys(releaseManifest.targets) : requestedTargets;
const unknownTarget = targets.find((target) => !releaseManifest.targets[target]);
if (unknownTarget) throw new Error(`未知发行目标：${unknownTarget}`);
if (outputRoot === path.parse(outputRoot).root) throw new Error("拒绝把文件系统根目录作为发行输出目录");

const cacheRoot = path.join(os.tmpdir(), "gaku-niku-portable-release-cache");
const stagingRoot = path.join(outputRoot, "staging");
await mkdir(cacheRoot, { recursive: true });
await mkdir(stagingRoot, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function sha256(file) {
  const hash = createHash("sha256");
  const bytes = await readFile(file);
  hash.update(bytes);
  return hash.digest("hex");
}

async function downloadVerified(asset) {
  const destination = path.join(cacheRoot, asset.file);
  try {
    if (await sha256(destination) === asset.sha256) return destination;
  } catch {
    // Download a fresh copy below.
  }
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}：${asset.url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  const actual = await sha256(temporary);
  if (actual !== asset.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`${asset.file} SHA256 不匹配：${actual}`);
  }
  await rm(destination, { force: true });
  await copyFile(temporary, destination);
  await rm(temporary, { force: true });
  return destination;
}

async function cleanCopy(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== ".DS_Store" && !name.startsWith("._") && name !== ".precision-subtitle-studio";
    },
  });
}

async function copyProjectFile(relativeSource, relativeDestination, root) {
  const source = path.join(projectRoot, relativeSource);
  const destination = path.join(root, relativeDestination || relativeSource);
  await mkdir(path.dirname(destination), { recursive: true });
  await cleanCopy(source, destination);
}

async function findNamedFile(root, names) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith("._")) continue;
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return candidate;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(candidate, names);
      if (nested) return nested;
    }
  }
  return "";
}

async function removeAppleDouble(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.name === ".DS_Store" || entry.name.startsWith("._")) {
      await rm(candidate, { recursive: entry.isDirectory(), force: true });
    } else if (entry.isDirectory()) {
      await removeAppleDouble(candidate);
    }
  }
}

async function extractArchive(archive, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run("tar", ["-xf", archive, "-C", destination]);
}

async function installNodeRuntime(target, root) {
  const asset = releaseManifest.node.assets[target];
  const archive = await downloadVerified(asset);
  const extracted = path.join(cacheRoot, `node-${target}-${releaseManifest.node.version}`);
  await extractArchive(archive, extracted);
  const windows = target.startsWith("windows-");
  const executable = await findNamedFile(extracted, windows ? ["node.exe"] : ["node"]);
  if (!executable) throw new Error(`${target} 的 Node 可执行文件不存在`);
  const nodeRoot = path.join(root, "runtime", "node");
  const nodeDestination = path.join(nodeRoot, windows ? "node.exe" : "bin/node");
  await mkdir(path.dirname(nodeDestination), { recursive: true });
  await copyFile(executable, nodeDestination);
  if (!windows) await chmod(nodeDestination, 0o755);
  const license = await findNamedFile(extracted, ["LICENSE"]);
  if (license) await copyFile(license, path.join(nodeRoot, "LICENSE"));
  await writeFile(path.join(nodeRoot, "VERSION"), `${releaseManifest.node.version}\n`, "utf8");
}

async function installUvToolchain(target, root) {
  const asset = runtimeManifest.uv.assets[target];
  if (!asset) throw new Error(`runtime-manifest.json 缺少 ${target} 的 uv 资产`);
  const archive = await downloadVerified(asset);
  const extracted = path.join(cacheRoot, `uv-${target}-${runtimeManifest.uv.version}`);
  await extractArchive(archive, extracted);
  const windows = target.startsWith("windows-");
  const uv = await findNamedFile(extracted, windows ? ["uv.exe"] : ["uv"]);
  const uvx = await findNamedFile(extracted, windows ? ["uvx.exe"] : ["uvx"]);
  if (!uv || !uvx) throw new Error(`${target} 的 uv/uvx 可执行文件不完整`);
  const destination = path.join(root, "runtime", "toolchain", target);
  await mkdir(destination, { recursive: true });
  await copyFile(uv, path.join(destination, windows ? "uv.exe" : "uv"));
  await copyFile(uvx, path.join(destination, windows ? "uvx.exe" : "uvx"));
  if (!windows) {
    await chmod(path.join(destination, "uv"), 0o755);
    await chmod(path.join(destination, "uvx"), 0o755);
  }
}

async function addApplicationFiles(root) {
  for (const [source, destination] of [
    ["standalone", "standalone"],
    ["public/favicon.svg", "public/favicon.svg"],
    ["harness/precision-video-subtitles", "harness/precision-video-subtitles"],
    ["local-agent-bridge/server.mjs", "local-agent-bridge/server.mjs"],
    ["local-agent-bridge/api-model-call.mjs", "local-agent-bridge/api-model-call.mjs"],
    ["local-agent-bridge/runtime-manager.mjs", "local-agent-bridge/runtime-manager.mjs"],
    ["local-agent-bridge/portable-launch.mjs", "local-agent-bridge/portable-launch.mjs"],
    ["runtime/runtime-manifest.json", "runtime/runtime-manifest.json"],
    ["runtime/api-pricing.json", "runtime/api-pricing.json"],
    ["release/PORTABLE_README.md", "README.md"],
    ["RELEASE_NOTES.md", "RELEASE_NOTES.md"],
  ]) await copyProjectFile(source, destination, root);

  for (const relative of ["package.json", "index.js", "LICENSE", "lib"]) {
    await copyProjectFile(path.join("node_modules", "undici", relative), path.join("node_modules", "undici", relative), root);
  }
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", ".keep"), "任务、知识库和模型数据会保存在此目录。\n", "utf8");
}

async function addLauncher(target, root) {
  if (target.startsWith("windows-")) {
    const contents = [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal",
      "cd /d \"%~dp0\"",
      "\"%~dp0runtime\\node\\node.exe\" \"%~dp0local-agent-bridge\\portable-launch.mjs\"",
      "if errorlevel 1 pause",
      "endlocal",
      "",
    ].join("\r\n");
    await writeFile(path.join(root, releaseManifest.targets[target].launcher), contents, "utf8");
    return;
  }
  const contents = [
    "#!/bin/sh",
    "set -eu",
    "APP_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
    "exec \"$APP_ROOT/runtime/node/bin/node\" \"$APP_ROOT/local-agent-bridge/portable-launch.mjs\"",
    "",
  ].join("\n");
  const launcher = path.join(root, releaseManifest.targets[target].launcher);
  await writeFile(launcher, contents, "utf8");
  await chmod(launcher, 0o755);
}

async function validatePackage(target, root) {
  const required = [
    "standalone/index.html",
    "standalone/dist/app.js",
    "standalone/dist/app.css",
    "public/favicon.svg",
    "local-agent-bridge/server.mjs",
    "local-agent-bridge/portable-launch.mjs",
    "node_modules/undici/index.js",
    "runtime/runtime-manifest.json",
    `runtime/toolchain/${target}/${target.startsWith("windows-") ? "uv.exe" : "uv"}`,
    target.startsWith("windows-") ? "runtime/node/node.exe" : "runtime/node/bin/node",
    releaseManifest.targets[target].launcher,
  ];
  for (const relative of required) {
    const info = await stat(path.join(root, relative));
    if (!info.isFile() || info.size === 0) throw new Error(`${target} 发行包缺少 ${relative}`);
  }
  if (target === `macos-${process.arch}` && process.platform === "darwin") {
    const bundledNode = path.join(root, "runtime", "node", "bin", "node");
    const version = run(bundledNode, ["--version"]);
    if (version !== `v${releaseManifest.node.version}`) throw new Error(`内置 Node 版本异常：${version}`);
  }
}

async function createZip(folder, destination) {
  await rm(destination, { force: true });
  if (process.platform === "win32") {
    const escapedFolder = folder.replaceAll("'", "''");
    const escapedDestination = destination.replaceAll("'", "''");
    run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${escapedFolder}' -DestinationPath '${escapedDestination}' -Force`]);
  } else {
    run("zip", ["-qry", destination, path.basename(folder), "-x", "*/._*", "*/.DS_Store"], { cwd: path.dirname(folder) });
  }
}

const artifacts = [];
for (const target of targets) {
  const folderName = `GakuNiku-v${packageJson.version}-${target}`;
  const root = path.join(stagingRoot, folderName);
  const artifact = path.join(outputRoot, `${folderName}.zip`);
  process.stdout.write(`\n[${target}] 准备发行目录\n`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await addApplicationFiles(root);
  await installNodeRuntime(target, root);
  await installUvToolchain(target, root);
  await addLauncher(target, root);
  await removeAppleDouble(root);
  await validatePackage(target, root);
  await createZip(root, artifact);
  artifacts.push({ target, artifact, sha256: await sha256(artifact), bytes: (await stat(artifact)).size });
  process.stdout.write(`[${target}] ${path.basename(artifact)} 完成\n`);
}

await writeFile(
  path.join(outputRoot, "SHA256SUMS.txt"),
  `${artifacts.map((item) => `${item.sha256}  ${path.basename(item.artifact)}`).join("\n")}\n`,
  "utf8",
);
process.stdout.write(`\n发行包已写入 ${outputRoot}\n`);
for (const artifact of artifacts) process.stdout.write(`${artifact.target}: ${path.basename(artifact.artifact)} (${(artifact.bytes / 1024 / 1024).toFixed(1)} MiB)\n`);
