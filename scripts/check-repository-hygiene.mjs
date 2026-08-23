import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const forbiddenFiles = [
  "package-lock.json",
  "release/SHA256SUMS.txt",
  "public/file.svg",
  "public/globe.svg",
  "public/window.svg",
];

const unexpected = [];
for (const relativePath of forbiddenFiles) {
  if (await exists(relativePath)) unexpected.push(relativePath);
}

const synchronizedPairs = [
  ["harness/precision-video-subtitles/scripts/init_job.py", "skills/gaku-niku/scripts/init_job.py"],
  ["harness/precision-video-subtitles/scripts/inspect_media.py", "skills/gaku-niku/scripts/inspect_media.py"],
  ["harness/precision-video-subtitles/scripts/validate_subtitles.py", "skills/gaku-niku/scripts/validate_subtitles.py"],
  ["harness/precision-video-subtitles/scripts/verify_mux.py", "skills/gaku-niku/scripts/verify_mux.py"],
];

for (const [harnessPath, skillPath] of synchronizedPairs) {
  const [harnessContents, skillContents] = await Promise.all([
    readFile(path.join(root, harnessPath), "utf8"),
    readFile(path.join(root, skillPath), "utf8"),
  ]);
  if (harnessContents !== skillContents) {
    unexpected.push(`${harnessPath} 与 ${skillPath} 不一致`);
  }
}

if (unexpected.length) {
  throw new Error(`仓库精简检查失败：\n- ${unexpected.join("\n- ")}`);
}

process.stdout.write("仓库精简检查通过。\n");
