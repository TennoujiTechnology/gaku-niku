import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyMergePatch, updateJsonAtomic } from "./manifest-store.mjs";

const [manifestArgument, patchArgument] = process.argv.slice(2);
if (!manifestArgument || !patchArgument) throw new Error("用法: node manifest-update.mjs manifest.json patch.json");
const manifestPath = path.resolve(manifestArgument);
if (path.basename(manifestPath) !== "manifest.json") throw new Error("只允许更新任务 manifest.json");
const patch = JSON.parse(await readFile(path.resolve(patchArgument), "utf8"));
if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Manifest patch 必须是 JSON 对象");
const updated = await updateJsonAtomic(manifestPath, (current) => applyMergePatch(current, patch), {});
process.stdout.write(`${JSON.stringify({ ok: true, schema_version: updated.schema_version || null })}\n`);
