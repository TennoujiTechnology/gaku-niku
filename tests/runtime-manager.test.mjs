import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executableNames, findExecutable, managedInstallCapabilities, managedUvPath, readRuntimeManifest, runtimeEnvironmentKey, runtimePlatformKey } from "../local-agent-bridge/runtime-manager.mjs";

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

test("Unix executable resolution requires an executable file", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pss-unix-cli-"));
  const command = path.join(directory, "uv");
  await writeFile(command, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(command, 0o644);
  assert.equal(findExecutable("uv", { platform: "darwin", env: { PATH: directory } }), null);
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
  assert.match(managedUvPath("/tmp/pss", manifest, "win32", "x64"), /windows-x64[\\/]uv\.exe$/);
});

test("environment fingerprints are deterministic and order independent", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packages = manifest.environments["asr-base"].packages;
  assert.equal(runtimeEnvironmentKey(packages), runtimeEnvironmentKey(packages.slice().reverse()));
  assert.notEqual(runtimeEnvironmentKey(packages), runtimeEnvironmentKey(manifest.environments.diarization.packages));
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
