import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRuntimeManifest, runtimeEnvironmentKey } from "../local-agent-bridge/runtime-manager.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await readRuntimeManifest(path.join(projectRoot, "runtime", "runtime-manifest.json"));
const targets = ["macos-arm64", "macos-x64", "windows-arm64", "windows-x64"];

for (const target of targets) {
  const asset = manifest.uv.assets[target];
  assert.ok(asset, `缺少 ${target} 的 uv 发布资产`);
  assert.match(asset.url, /^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\//);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
}

for (const target of ["macos-arm64", "windows-x64"]) {
  const assets = manifest.nativeTools?.assets?.[target];
  assert.ok(assets?.ffmpeg && assets?.ffprobe, `缺少 ${target} 的 FFmpeg/FFprobe 发布资产`);
  for (const [name, asset] of Object.entries(assets)) {
    assert.match(asset.url, /^https:\/\/github\.com\/shaka-project\/static-ffmpeg-binaries\/releases\/download\//, `${name} 必须来自固定 Release`);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/, `${target} ${name} 缺少 SHA256`);
    assert.ok(asset.bytes > 10_000_000, `${target} ${name} 体积异常`);
  }
}

for (const [name, environment] of Object.entries(manifest.environments)) {
  assert.ok(environment.packages.length > 0, `${name} 没有依赖`);
  assert.ok(environment.packages.every((item) => /^[A-Za-z0-9_.-]+==[^=]+$/.test(item)), `${name} 存在未固定版本的依赖`);
  process.stdout.write(`${name}: ${runtimeEnvironmentKey(environment.packages)}\n`);
}

for (const [name, asset] of Object.entries(manifest.environments["diarization-sherpa"].models || {})) {
  assert.match(asset.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//, `${name} 模型必须来自 Sherpa-ONNX 官方 Release`);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/, `${name} 模型缺少 SHA256`);
  assert.ok(asset.bytes > 1_000_000, `${name} 模型体积异常`);
}

process.stdout.write(`runtime manifest OK · uv ${manifest.uv.version} · FFmpeg/FFprobe ${manifest.nativeTools.version} · Python ${manifest.python.version}\n`);
