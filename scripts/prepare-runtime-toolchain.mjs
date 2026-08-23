import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureManagedNativeTools, ensureManagedUv, managedNativeToolPath, managedUvPath, managedUvxPath, readRuntimeManifest, runtimePlatformKey } from "../local-agent-bridge/runtime-manager.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "runtime", "runtime-manifest.json");
const packagedRoot = path.join(projectRoot, "runtime", "toolchain");
const manifest = await readRuntimeManifest(manifestPath);
const platformKey = runtimePlatformKey();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pss-runtime-release-"));

try {
  const prepared = await ensureManagedUv({
    runtimeRoot: temporaryRoot,
    manifestPath,
    packagedRoot,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  const destination = path.join(packagedRoot, platformKey);
  await mkdir(destination, { recursive: true });
  const uvDestination = path.join(destination, process.platform === "win32" ? "uv.exe" : "uv");
  await copyFile(managedUvPath(temporaryRoot, manifest), uvDestination);
  if (process.platform !== "win32") await chmod(uvDestination, 0o755);
  const uvxSource = managedUvxPath(temporaryRoot, manifest);
  const uvxDestination = path.join(destination, process.platform === "win32" ? "uvx.exe" : "uvx");
  await copyFile(uvxSource, uvxDestination).catch(() => undefined);
  if (process.platform !== "win32") await chmod(uvxDestination, 0o755).catch(() => undefined);
  const nativeTools = await ensureManagedNativeTools({
    runtimeRoot: temporaryRoot,
    manifestPath,
    packagedRoot,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  for (const name of ["ffmpeg", "ffprobe"]) {
    const source = managedNativeToolPath(temporaryRoot, manifest, name);
    const target = path.join(destination, process.platform === "win32" ? `${name}.exe` : name);
    await copyFile(source, target);
    if (process.platform !== "win32") await chmod(target, 0o755);
  }
  process.stdout.write(`prepared ${platformKey} · uv ${prepared.version} · FFmpeg/FFprobe ${nativeTools.version}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
