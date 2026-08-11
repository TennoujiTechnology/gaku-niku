import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the subtitle studio product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>自学型熟肉机<\/title>/i);
  assert.match(html, /自学型熟肉机/);
  assert.match(html, /新建字幕工程/);
  assert.match(html, /翻译前预习/);
  assert.match(html, /Agent CLI/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("ships the real harness and low-memory local bridge", async () => {
  const [component, bridge, skill, packageJson] = await Promise.all([
    readFile(new URL("../app/SubtitleStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../local-agent-bridge/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../harness/precision-video-subtitles/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  for (const phrase of ["Bilibili", "YouTube", "yt-dlp", "逐句精修", "最多两行", "角色色效果"]) {
    assert.match(component, new RegExp(phrase));
  }
  assert.match(bridge, /127\.0\.0\.1/);
  assert.match(bridge, /child\.stdout\.pipe\(outputLog\)/);
  assert.match(bridge, /apiKey: config\.engine\?\.apiKey \? "\[provided at launch only\]"/);
  assert.match(skill, /Never load a full long video\/audio into memory/);
  assert.match(packageJson, /"bridge": "node local-agent-bridge\/server\.mjs"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(new URL("../.openai/hosting.json", import.meta.url));
});
