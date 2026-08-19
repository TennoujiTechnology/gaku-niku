export const ambiguityReviewPresets = {
  fast: {
    label: "快速放行",
    deepReviewLimit: 8,
    description: "只复核最可能改变核心意思的疑点，其余采用保守译法并留给精修台。",
  },
  pragmatic: {
    label: "适度放行（推荐）",
    deepReviewLimit: 24,
    description: "先分级，再深查关键疑点；普通口癖、填充词和低影响差异自动放行。",
  },
  strict: {
    label: "逐项严格复核",
    deepReviewLimit: null,
    description: "逐项取证所有实质疑点；只有此模式允许因关键疑点无法解决而阻塞。",
  },
};

export function normalizeAmbiguityReviewMode(value) {
  return Object.hasOwn(ambiguityReviewPresets, value) ? value : "pragmatic";
}

export function ambiguityReviewModeFromConfig(config) {
  return normalizeAmbiguityReviewMode(
    config?.reviewPolicy?.ambiguity?.mode ?? config?.execution?.ambiguityReviewMode,
  );
}

export function workflowPhaseStatus(id, phase) {
  const raw = String(phase?.status || "pending");
  if (id !== "resolve_ambiguities" || raw !== "blocked") return raw;
  const policy = String(phase?.policy || "");
  const hasRiskSummary = phase?.risk_summary && typeof phase.risk_summary === "object";
  if (["fast", "pragmatic"].includes(policy) && phase.blocking === false && hasRiskSummary) return "complete";
  return raw;
}

export function ambiguityReviewPolicyPrompt(value) {
  const mode = normalizeAmbiguityReviewMode(value);
  const preset = ambiguityReviewPresets[mode];
  const budget = preset.deepReviewLimit == null
    ? "逐项处理所有实质疑点"
    : `最多深查 ${preset.deepReviewLimit} 个最高风险时间点；超过预算的项目必须自动放行并留给精修台`;
  return [
    `第五阶段疑点复核策略: ${mode}/${preset.label}。${preset.description}`,
    "先对全部候选做一次不调用媒体工具的快速分级：critical=可能改变否定、数字/日期、人物/说话人、反复出现的专名、核心谓词、因果或笑点；review=有多种读法但不改变主要意思；minor=口癖、语气词、轻微措辞、无关背景声、标点或不影响译文的说话人身份。低 ASR 置信度本身不等于 critical。",
    `取证预算: ${budget}。critical 优先，其次只处理最有价值的 review；相邻时间点合并成一个音频窗口并批量二次听写，禁止为每条疑点重复加载 ASR 模型。`,
    "只在画面确实可能包含姓名卡、字幕、标牌或其他可裁决文字时抽帧/OCR；纯听觉问题不得机械抽三帧。只有可复用的专名或关键事实才联网搜索，单个网页失败直接换来源并继续。",
    "review/minor 默认采用上下文支持且不增加事实的保守译法。minor 可标为 ignored_non_material；review 可标为 accepted_risk，并在 studio-review.json 中保留 flagged=true，供用户进入精修台后按需查看。不得把低影响项目升级成阻塞。",
    mode === "strict"
      ? "strict 模式下，关键意思确实无法诚实定稿时可以把 resolve_ambiguities 标为 blocked，并说明需要用户确认的最小问题。"
      : "fast/pragmatic 模式下，疑点本身不得阻塞任务。无法完全解决的 critical 使用尽可能中性的译法，标为 accepted_risk/flagged，写入 manifest limitations 和 ambiguity report，然后将 resolve_ambiguities 标为 complete 并继续字幕质检。不得伪造高置信度或宣称语义已精校通过。",
    "输出 work/ambiguity-report.json，至少记录 policy、candidate_count、deep_reviewed_count、auto_accepted_count、critical_remaining_count，以及每项 risk_level、disposition、evidence。同步在 manifest.phases.resolve_ambiguities 写入 policy、blocking 和 risk_summary（total、critical、review、minor、deep_reviewed、auto_released、needs_refine）；fast/pragmatic 的 blocking 必须为 false。TSV 中 resolved、accepted_risk、ignored_non_material 都是可结束状态；只有 strict 模式的 pending critical 可以阻塞。",
  ].join("\n");
}
