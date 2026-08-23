import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

const managedUvInstallLocks = new Map();
const managedNativeToolInstallLocks = new Map();

export function runtimePlatformKey(platform = process.platform, arch = process.arch) {
  const family = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  return `${family}-${cpu}`;
}

export function executableNames(name, platform = process.platform, env = process.env) {
  if (platform !== "win32" || path.extname(name)) return [name];
  const extensions = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([name, ...extensions.flatMap((extension) => [name + extension.toLowerCase(), name + extension.toUpperCase()])])];
}

function executableFile(file, platform = process.platform) {
  try {
    accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

export function findExecutable(name, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const names = executableNames(name, platform, env);
  const candidates = [];
  for (const candidate of options.extraCandidates || []) {
    if (!candidate) continue;
    if (path.extname(candidate) || platform !== "win32") candidates.push(candidate);
    else candidates.push(...executableNames(candidate, platform, env));
  }
  const pathSeparator = platform === "win32" ? ";" : ":";
  for (const entry of String(env.PATH || "").split(pathSeparator)) {
    if (!entry) continue;
    for (const candidate of names) candidates.push(path.join(entry, candidate));
  }
  for (const candidate of candidates) {
    const found = executableFile(candidate, platform);
    if (found) return found;
  }
  return null;
}

export async function readRuntimeManifest(manifestPath) {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  if (parsed.schemaVersion !== 1 || !parsed.uv?.version || !parsed.python?.version) throw new Error("运行时清单格式无效");
  return parsed;
}

function managedUvDirectory(runtimeRoot, manifest, platform = process.platform, arch = process.arch) {
  return path.join(runtimeRoot, "toolchain", "uv", manifest.uv.version, runtimePlatformKey(platform, arch));
}

export function managedUvPath(runtimeRoot, manifest, platform = process.platform, arch = process.arch) {
  return path.join(managedUvDirectory(runtimeRoot, manifest, platform, arch), platform === "win32" ? "uv.exe" : "uv");
}

export function managedUvxPath(runtimeRoot, manifest, platform = process.platform, arch = process.arch) {
  return path.join(managedUvDirectory(runtimeRoot, manifest, platform, arch), platform === "win32" ? "uvx.exe" : "uvx");
}

function managedNativeToolDirectory(runtimeRoot, manifest, platform = process.platform, arch = process.arch) {
  return path.join(runtimeRoot, "toolchain", "native", manifest.nativeTools.version, runtimePlatformKey(platform, arch));
}

export function managedNativeToolPath(runtimeRoot, manifest, name, platform = process.platform, arch = process.arch) {
  return path.join(managedNativeToolDirectory(runtimeRoot, manifest, platform, arch), platform === "win32" ? `${name}.exe` : name);
}

async function findExtractedExecutable(root, names) {
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile() && names.includes(entry.name)) return candidate;
    }
  }
  return null;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, ...options });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(stderr.trim() || `${command} 解压失败（代码 ${code}）`);
}

async function downloadVerified(url, destination, expectedSha256, fetchOptions = {}, label = "托管工具链") {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), ...fetchOptions });
  if (!response.ok || !response.body) throw new Error(`下载${label}失败：HTTP ${response.status}`);
  const file = await open(destination, "wx");
  const hash = createHash("sha256");
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      hash.update(chunk);
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) throw new Error(`${label} SHA256 校验失败：期望 ${expectedSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
}

async function ensureManagedUvUnlocked(options) {
  const { runtimeRoot, manifestPath, packagedRoot, onProgress = () => {}, fetchOptions = {} } = options;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const manifest = await readRuntimeManifest(manifestPath);
  const platformKey = runtimePlatformKey(platform, arch);
  const asset = manifest.uv.assets[platformKey];
  if (!asset) throw new Error(`当前发布包暂不支持 ${platformKey}`);
  const targetDirectory = managedUvDirectory(runtimeRoot, manifest, platform, arch);
  const target = managedUvPath(runtimeRoot, manifest, platform, arch);
  const uvxTarget = managedUvxPath(runtimeRoot, manifest, platform, arch);
  if (executableFile(target, platform)) return { path: target, version: manifest.uv.version, source: "managed" };

  const packaged = path.join(packagedRoot, platformKey, platform === "win32" ? "uv.exe" : "uv");
  if (executableFile(packaged, platform)) {
    onProgress("正在启用随应用提供的 uv 工具链");
    const stagingTarget = `${targetDirectory}.staging-${Date.now()}`;
    await rm(stagingTarget, { recursive: true, force: true });
    await mkdir(stagingTarget, { recursive: true });
    const stagedExecutable = path.join(stagingTarget, path.basename(target));
    await copyFile(packaged, stagedExecutable);
    if (platform !== "win32") await chmod(stagedExecutable, 0o755);
    const packagedUvx = path.join(packagedRoot, platformKey, platform === "win32" ? "uvx.exe" : "uvx");
    if (executableFile(packagedUvx, platform)) {
      const stagedUvx = path.join(stagingTarget, path.basename(uvxTarget));
      await copyFile(packagedUvx, stagedUvx);
      if (platform !== "win32") await chmod(stagedUvx, 0o755);
    }
    await mkdir(path.dirname(targetDirectory), { recursive: true });
    await rm(targetDirectory, { recursive: true, force: true });
    await rename(stagingTarget, targetDirectory);
    return { path: target, version: manifest.uv.version, source: "packaged" };
  }

  onProgress(`正在下载应用托管 uv ${manifest.uv.version}`);
  const staging = `${targetDirectory}.staging-${Date.now()}`;
  const archive = path.join(staging, asset.file);
  const extracted = path.join(staging, "extracted");
  await rm(staging, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  try {
    await downloadVerified(asset.url, archive, asset.sha256, fetchOptions, "uv");
    onProgress("uv 已下载并通过 SHA256 校验，正在解压");
    if (asset.format === "zip") {
      if (platform !== "win32") throw new Error("ZIP 工具链包只允许在 Windows 解压");
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", archive, extracted]);
    } else {
      await run("tar", ["-xzf", archive, "-C", extracted]);
    }
    const uv = await findExtractedExecutable(extracted, platform === "win32" ? ["uv.exe"] : ["uv"]);
    if (!uv) throw new Error("uv 工具链包中没有找到可执行文件");
    const uvx = await findExtractedExecutable(extracted, platform === "win32" ? ["uvx.exe"] : ["uvx"]);
    const installDirectory = path.join(staging, "install");
    const stagedExecutable = path.join(installDirectory, path.basename(target));
    await mkdir(installDirectory, { recursive: true });
    await copyFile(uv, stagedExecutable);
    if (platform !== "win32") await chmod(stagedExecutable, 0o755);
    if (uvx) {
      const stagedUvx = path.join(installDirectory, path.basename(uvxTarget));
      await copyFile(uvx, stagedUvx);
      if (platform !== "win32") await chmod(stagedUvx, 0o755);
    }
    await writeFile(path.join(installDirectory, "install.json"), `${JSON.stringify({ version: manifest.uv.version, platform: platformKey, sha256: asset.sha256, installedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(targetDirectory), { recursive: true });
    await rm(targetDirectory, { recursive: true, force: true });
    await rename(installDirectory, targetDirectory);
    return { path: target, version: manifest.uv.version, source: "download" };
  } catch (error) {
    await rm(targetDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function ensureManagedUv(options) {
  const key = `${path.resolve(options.runtimeRoot)}:${options.platform || process.platform}:${options.arch || process.arch}`;
  const existing = managedUvInstallLocks.get(key);
  if (existing) return existing;
  const pending = ensureManagedUvUnlocked(options).finally(() => managedUvInstallLocks.delete(key));
  managedUvInstallLocks.set(key, pending);
  return pending;
}

async function ensureManagedNativeToolsUnlocked(options) {
  const { runtimeRoot, manifestPath, packagedRoot, onProgress = () => {}, fetchOptions = {} } = options;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const manifest = await readRuntimeManifest(manifestPath);
  const platformKey = runtimePlatformKey(platform, arch);
  const assets = manifest.nativeTools?.assets?.[platformKey];
  if (!assets?.ffmpeg || !assets?.ffprobe) throw new Error(`当前发布包暂不支持为 ${platformKey} 托管 FFmpeg/FFprobe`);
  const toolNames = ["ffmpeg", "ffprobe"];
  const targetDirectory = managedNativeToolDirectory(runtimeRoot, manifest, platform, arch);
  const targets = Object.fromEntries(toolNames.map((name) => [name, managedNativeToolPath(runtimeRoot, manifest, name, platform, arch)]));
  if (toolNames.every((name) => executableFile(targets[name], platform))) {
    return { paths: targets, version: manifest.nativeTools.version, source: "managed" };
  }

  const packaged = Object.fromEntries(toolNames.map((name) => [name, path.join(packagedRoot, platformKey, platform === "win32" ? `${name}.exe` : name)]));
  const packagedReady = toolNames.every((name) => executableFile(packaged[name], platform));
  const staging = `${targetDirectory}.staging-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    if (packagedReady) {
      onProgress("正在启用随应用提供的 FFmpeg/FFprobe 工具链");
      for (const name of toolNames) {
        const destination = path.join(staging, path.basename(targets[name]));
        await copyFile(packaged[name], destination);
        if (platform !== "win32") await chmod(destination, 0o755);
      }
    } else {
      for (const name of toolNames) {
        const asset = assets[name];
        onProgress(`正在下载应用托管 ${name} ${manifest.nativeTools.version}`);
        const destination = path.join(staging, path.basename(targets[name]));
        await downloadVerified(asset.url, destination, asset.sha256, fetchOptions, name);
        if (platform !== "win32") await chmod(destination, 0o755);
      }
    }
    await writeFile(path.join(staging, "install.json"), `${JSON.stringify({
      version: manifest.nativeTools.version,
      platform: platformKey,
      assets: Object.fromEntries(toolNames.map((name) => [name, assets[name].sha256])),
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(targetDirectory), { recursive: true });
    await rm(targetDirectory, { recursive: true, force: true });
    await rename(staging, targetDirectory);
    return { paths: targets, version: manifest.nativeTools.version, source: packagedReady ? "packaged" : "download" };
  } catch (error) {
    await rm(targetDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function ensureManagedNativeTools(options) {
  const key = `${path.resolve(options.runtimeRoot)}:${options.platform || process.platform}:${options.arch || process.arch}`;
  const existing = managedNativeToolInstallLocks.get(key);
  if (existing) return existing;
  const pending = ensureManagedNativeToolsUnlocked(options).finally(() => managedNativeToolInstallLocks.delete(key));
  managedNativeToolInstallLocks.set(key, pending);
  return pending;
}

export function runtimeEnvironmentKey(packages) {
  return createHash("sha256").update(packages.slice().sort().join("\n")).digest("hex").slice(0, 12);
}

function supportsPython(version, minimumMinor, maximumMinor = Infinity) {
  return Boolean(version && version[0] === 3 && version[1] >= minimumMinor && version[1] < maximumMinor);
}

export function managedInstallCapabilities(options = {}) {
  const bootstrapAvailable = Boolean(options.uvAvailable || options.toolchainSupported);
  return {
    base: bootstrapAvailable || supportsPython(options.systemPythonVersion, 9),
    diarization: bootstrapAvailable
      || supportsPython(options.basePythonVersion, 10, 14)
      || supportsPython(options.systemPythonVersion, 10, 14),
  };
}
