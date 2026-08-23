import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureManagedNativeTools, executableNames, findExecutable, managedInstallCapabilities, managedNativeToolPath, managedUvPath, readRuntimeManifest, runtimeEnvironmentKey, runtimePlatformKey } from "../local-agent-bridge/runtime-manager.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(projectRoot, "runtime", "runtime-manifest.json");

test("runtime platform keys cover supported macOS and Windows release targets", () => {
  assert.equal(runtimePlatformKey("darwin", "arm64"), "macos-arm64");
  assert.equal(runtimePlatformKey("darwin", "x64"), "macos-x64");
  assert.equal(runtimePlatformKey("win32", "arm64"), "windows-arm64");
  assert.equal(runtimePlatformKey("win32", "x64"), "windows-x64");
});

test("Windows executable resolution honors PATHEXT", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pss-windows-cli-"));
  const command = path.join(directory, "codex.cmd");
  await writeFile(command, "@echo off\r\n", "utf8");
  const names = executableNames("codex", "win32", { PATHEXT: ".EXE;.CMD" });
  assert.ok(names.includes("codex.cmd"));
  assert.equal(findExecutable("codex", { platform: "win32", env: { PATH: directory, PATHEXT: ".EXE;.CMD" } }), command);
});

test("Unix executable resolution requires an executable file", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pss-unix-cli-"));
  const command = path.join(directory, "uv");
  await writeFile(command, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(command, 0o644);
  if (findExecutable("uv", { platform: "darwin", env: { PATH: directory } })) {
    t.skip("temporary filesystem does not preserve Unix executable bits");
    return;
  }
  await chmod(command, 0o755);
  assert.equal(findExecutable("uv", { platform: "darwin", env: { PATH: directory } }), command);
});

test("runtime manifest pins tools and every supported uv archive checksum", async () => {
  const manifest = await readRuntimeManifest(manifestPath);
  for (const target of ["macos-arm64", "macos-x64", "windows-arm64", "windows-x64"]) {
    assert.match(manifest.uv.assets[target].sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.uv.assets[target].url, new RegExp(`/download/${manifest.uv.version.replaceAll(".", "\\.")}/`));
  }
  for (const environment of Object.values(manifest.environments)) {
    assert.ok(environment.packages.length > 0);
    assert.ok(environment.packages.every((item) => item.includes("==")), `unversioned package in ${JSON.stringify(environment.packages)}`);
  }
  assert.ok(manifest.environments["asr-base"].packages.includes("socksio==1.0.0"), "ASR runtime must support inherited SOCKS proxies");
  for (const target of ["macos-arm64", "windows-x64"]) {
    for (const name of ["ffmpeg", "ffprobe"]) {
      const asset = manifest.nativeTools.assets[target][name];
      assert.match(asset.url, new RegExp(`/download/${manifest.nativeTools.version.replaceAll(".", "\\.")}/`));
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.ok(asset.bytes > 10_000_000);
    }
  }
  for (const asset of Object.values(manifest.environments["diarization-sherpa"].models)) {
    assert.match(asset.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(asset.bytes > 1_000_000);
  }
  assert.match(managedUvPath("/tmp/pss", manifest, "win32", "x64"), /windows-x64[\\/]uv\.exe$/);
  assert.match(managedNativeToolPath("/tmp/pss", manifest, "ffmpeg", "win32", "x64"), /windows-x64[\\/]ffmpeg\.exe$/);
});

test("managed FFmpeg and FFprobe are copied atomically into the project runtime", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pss-native-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeRoot = path.join(directory, "project-runtime");
  const packagedRoot = path.join(directory, "packaged");
  const packagedPlatform = path.join(packagedRoot, "macos-arm64");
  await mkdir(packagedPlatform, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"]) {
    const executable = path.join(packagedPlatform, name);
    await writeFile(executable, `#!/bin/sh\necho ${name} fixture\n`, "utf8");
    await chmod(executable, 0o755);
  }

  const result = await ensureManagedNativeTools({ runtimeRoot, manifestPath, packagedRoot, platform: "darwin", arch: "arm64" });
  const manifest = await readRuntimeManifest(manifestPath);
  assert.equal(result.source, "packaged");
  assert.equal(result.version, manifest.nativeTools.version);
  for (const name of ["ffmpeg", "ffprobe"]) {
    assert.equal(result.paths[name], managedNativeToolPath(runtimeRoot, manifest, name, "darwin", "arm64"));
    assert.match(await readFile(result.paths[name], "utf8"), new RegExp(`${name} fixture`));
  }
  const installState = JSON.parse(await readFile(path.join(path.dirname(result.paths.ffmpeg), "install.json"), "utf8"));
  assert.equal(installState.platform, "macos-arm64");
});

test("environment fingerprints are deterministic and order independent", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packages = manifest.environments["asr-base"].packages;
  assert.equal(runtimeEnvironmentKey(packages), runtimeEnvironmentKey(packages.slice().reverse()));
  assert.notEqual(runtimeEnvironmentKey(packages), runtimeEnvironmentKey(manifest.environments["diarization-sherpa"].packages));
  assert.notEqual(runtimeEnvironmentKey(manifest.environments["diarization-sherpa"].packages), runtimeEnvironmentKey(manifest.environments["diarization-pyannote"].packages));
});

test("a valid managed base Python can prepare WhisperX even when system Python is too old", () => {
  const capabilities = managedInstallCapabilities({
    uvAvailable: false,
    toolchainSupported: false,
    basePythonVersion: [3, 11, 15],
    systemPythonVersion: [3, 9, 6],
  });
  assert.equal(capabilities.base, true);
  assert.equal(capabilities.diarization, true);
});
