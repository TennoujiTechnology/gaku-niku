import assert from "node:assert/strict";
import test from "node:test";

import {
  ambiguityReviewModeFromConfig,
  ambiguityReviewPolicyPrompt,
  normalizeAmbiguityReviewMode,
  workflowPhaseStatus,
} from "../local-agent-bridge/ambiguity-policy.mjs";

test("ambiguity review defaults to pragmatic release", () => {
  assert.equal(normalizeAmbiguityReviewMode(undefined), "pragmatic");
  assert.equal(normalizeAmbiguityReviewMode("unexpected"), "pragmatic");
  assert.equal(ambiguityReviewModeFromConfig({}), "pragmatic");
  assert.equal(ambiguityReviewModeFromConfig({ reviewPolicy: { ambiguity: { mode: "strict" } } }), "strict");
});

test("pragmatic prompt budgets deep review and makes OCR conditional", () => {
  const prompt = ambiguityReviewPolicyPrompt("pragmatic");
  assert.match(prompt, /最多深查 24 个/);
  assert.match(prompt, /低 ASR 置信度本身不等于 critical/);
  assert.match(prompt, /纯听觉问题不得机械抽三帧/);
  assert.match(prompt, /accepted_risk/);
  assert.match(prompt, /不得阻塞任务/);
  assert.match(prompt, /manifest\.phases\.resolve_ambiguities/);
});

test("fast lowers the budget while strict preserves a real blocker", () => {
  assert.match(ambiguityReviewPolicyPrompt("fast"), /最多深查 8 个/);
  assert.match(ambiguityReviewPolicyPrompt("strict"), /可以把 resolve_ambiguities 标为 blocked/);
});

test("explicit non-blocking review summary releases a mistaken blocked phase", () => {
  assert.equal(workflowPhaseStatus("resolve_ambiguities", {
    status: "blocked",
    policy: "pragmatic",
    blocking: false,
    risk_summary: { total: 20, auto_released: 18, needs_refine: 2 },
  }), "complete");
  assert.equal(workflowPhaseStatus("resolve_ambiguities", { status: "blocked" }), "blocked");
  assert.equal(workflowPhaseStatus("resolve_ambiguities", {
    status: "blocked",
    policy: "strict",
    blocking: true,
    risk_summary: { total: 1, needs_refine: 1 },
  }), "blocked");
  assert.equal(workflowPhaseStatus("source_transcript", { status: "blocked", blocking: false, risk_summary: {} }), "blocked");
});
