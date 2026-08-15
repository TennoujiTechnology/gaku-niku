import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../runtime/api-pricing.json", import.meta.url), "utf8"));

function estimate(usage, rule) {
  return (usage.input * rule.inputPerMillion + usage.output * rule.outputPerMillion) / 1_000_000;
}

test("embeds official token rates for every preset API model", () => {
  const expected = {
    openai: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    xai: ["grok-4.5", "grok-4.3"],
    deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
    kimi: ["kimi-k3", "kimi-k2.6"],
    kimi_intl: ["kimi-k3", "kimi-k2.6"],
    mimo: ["mimo-v2.5-pro", "mimo-v2.5"],
    minimax: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    glm: ["glm-5.2"],
  };

  for (const [provider, models] of Object.entries(expected)) {
    assert.match(manifest.providers[provider].docsUrl, /^https:\/\//);
    for (const model of models) {
      const rule = manifest.providers[provider].models[model];
      assert.ok(rule, `${provider}/${model} should have a price rule`);
      assert.ok(["CNY", "USD"].includes(rule.currency));
      assert.ok(rule.inputPerMillion > 0);
      assert.ok(rule.outputPerMillion > 0);
    }
  }
});

test("estimates MiMo cost with separate input and output rates", () => {
  const rule = manifest.providers.mimo.models["mimo-v2.5"];
  const value = estimate({ input: 24_289, output: 4_009 }, rule);
  assert.equal(value, 0.032307);
});

test("keeps the conservative cache-miss estimation policy explicit", () => {
  assert.match(manifest.estimationPolicy, /cache-miss rate/);
  assert.equal(manifest.providers.kimi.models["kimi-k2.6"].cachedInputPerMillion, 1.1);
  assert.equal(manifest.providers.glm.models["glm-5.2"].outputPerMillion, 28);
});
