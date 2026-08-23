import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyMergePatch, updateJsonAtomic } from "./manifest-store.mjs";

const phaseOrder = ["acquire", "research", "source_transcript", "translate", "resolve_ambiguities", "subtitle_qc", "mux", "final_validation"];
const allowedPhases = new Set(phaseOrder);
const allowedStatuses = new Set(["pending", "in_progress", "running", "complete", "completed", "blocked", "error", "skipped"]);
const completedStatuses = new Set(["complete", "completed", "skipped"]);

function validatePhaseOrder(manifest) {
  const phases = manifest?.phases && typeof manifest.phases === "object" ? manifest.phases : {};
  let firstIncomplete = "";
  for (const phaseName of phaseOrder) {
    const status = String(phases[phaseName]?.status || "pending");
    if (completedStatuses.has(status)) {
      if (firstIncomplete) throw new Error(`Manifest 阶段不能越序：${firstIncomplete} 尚未完成，不能把 ${phaseName} 标为 ${status}`);
      continue;
    }
    if (!firstIncomplete) {
      firstIncomplete = phaseName;
      continue;
    }
    if (["in_progress", "running", "blocked", "error"].includes(status)) {
      throw new Error(`Manifest 同时推进了多个阶段：应先处理 ${firstIncomplete}，${phaseName} 必须保持 pending`);
    }
  }
}

const [manifestArgument, patchArgument] = process.argv.slice(2);
if (!manifestArgument || !patchArgument) throw new Error("用法: node manifest-update.mjs manifest.json patch.json");
const manifestPath = path.resolve(manifestArgument);
if (path.basename(manifestPath) !== "manifest.json") throw new Error("只允许更新任务 manifest.json");
const patch = JSON.parse(await readFile(path.resolve(patchArgument), "utf8"));
if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Manifest patch 必须是 JSON 对象");
if (patch.phases != null) {
  if (!patch.phases || typeof patch.phases !== "object" || Array.isArray(patch.phases)) throw new Error("Manifest phases patch 必须是对象");
  for (const [phaseName, phasePatch] of Object.entries(patch.phases)) {
    if (!allowedPhases.has(phaseName)) throw new Error(`Manifest 不允许未知阶段：${phaseName}`);
    if (phasePatch === null) continue;
    if (typeof phasePatch !== "object" || Array.isArray(phasePatch)) throw new Error(`Manifest 阶段 ${phaseName} 必须是对象`);
    if (phasePatch.status != null && !allowedStatuses.has(String(phasePatch.status))) throw new Error(`Manifest 阶段 ${phaseName} 的状态无效：${phasePatch.status}`);
    if (phasePatch.evidence != null && !Array.isArray(phasePatch.evidence)) throw new Error(`Manifest 阶段 ${phaseName} 的 evidence 必须是数组`);
  }
}
for (const key of ["limitations", "notices"]) {
  if (patch[key] != null && !Array.isArray(patch[key])) throw new Error(`Manifest ${key} 必须是数组`);
}
const updated = await updateJsonAtomic(manifestPath, (current) => {
  const next = applyMergePatch(current, patch);
  if (patch.phases != null) validatePhaseOrder(next);
  return next;
}, {});
process.stdout.write(`${JSON.stringify({ ok: true, schema_version: updated.schema_version || null })}\n`);
