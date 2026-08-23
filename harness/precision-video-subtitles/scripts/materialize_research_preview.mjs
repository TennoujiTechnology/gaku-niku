#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [previewArgument, jobArgument] = process.argv.slice(2);
if (!previewArgument || !jobArgument) {
  throw new Error("用法: node materialize_research_preview.mjs PREVIEW.md JOB_DIR");
}

const previewPath = path.resolve(previewArgument);
const jobDirectory = path.resolve(jobArgument);
const researchDirectory = path.join(jobDirectory, "research");
const source = await readFile(previewPath, "utf8");
await mkdir(researchDirectory, { recursive: true });

function sections(markdown) {
  const result = new Map();
  let current = "导言";
  result.set(current, []);
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1].trim();
      if (!result.has(current)) result.set(current, []);
      continue;
    }
    result.get(current).push(line);
  }
  return result;
}

function tableRows(lines) {
  const rows = lines
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  if (rows.length < 2) return [];
  const header = rows[0].map(stripMarkdown);
  const body = /^\s*:?-{3,}/.test(rows[1][0] || "") ? rows.slice(2) : rows.slice(1);
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] || ""])));
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .trim();
}

function firstUrl(value) {
  return String(value || "").match(/https?:\/\/[^)\s,，]+/)?.[0] || "";
}

function field(row, patterns) {
  const key = Object.keys(row).find((name) => patterns.some((pattern) => pattern.test(name)));
  return key ? row[key] : "";
}

function confidence(value) {
  const text = stripMarkdown(value).toLowerCase();
  if (/高|high/.test(text)) return "high";
  if (/低|low/.test(text)) return "low";
  return "medium";
}

function identity(value) {
  const text = stripMarkdown(value);
  if (/本人|声优|出演者|performer/i.test(text)) return "performer";
  if (/角色|character/i.test(text)) return "character";
  return "unknown";
}

function colourScope(value) {
  const text = stripMarkdown(value);
  if (/应援|support/i.test(text)) return "performer_support";
  if (/成员|团队|group/i.test(text)) return "group_member";
  if (/角色|character/i.test(text)) return "character";
  return "fallback";
}

function comparableName(value) {
  return stripMarkdown(value).replace(/[\s　()（）·・]/g, "").toLowerCase();
}

function tsv(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

const parsedSections = sections(source);
const briefNames = ["检索目标", "关键词", "人物与关系", "时间线与语境", "翻译决定"];
const briefParts = [`# ${source.match(/^#\s+(.+)$/m)?.[1] || "翻译前预习"}`, `> 从用户核准的预习文档确定性整理；原文：${previewPath}`];
for (const name of briefNames) {
  const content = parsedSections.get(name)?.join("\n").trim();
  if (content) briefParts.push(`## ${name}\n\n${content}`);
}

const sourceRows = [];
let currentSection = "导言";
for (const line of source.split(/\r?\n/)) {
  const heading = line.match(/^##\s+(.+?)\s*$/);
  if (heading) currentSection = heading[1].trim();
  for (const match of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
    sourceRows.push({ label: match[1].trim(), url: match[2].trim(), section: currentSection });
  }
}
const uniqueSources = [...new Map(sourceRows.map((item) => [item.url, item])).values()];
const accessed = new Date().toISOString().slice(0, 10);
const sourcesMarkdown = ["# 研究来源", "", `> 整理日期：${accessed}；由用户核准预习中的直接链接生成。`, ""];
for (const item of uniqueSources) sourcesMarkdown.push(`- [${item.label}](${item.url}) — 支持章节：${item.section}`);

const glossaryRows = tableRows(parsedSections.get("术语表") || []);
const glossaryHeader = ["source_term", "reading", "canonical_target", "category", "evidence_url", "confidence", "notes"];
const glossary = glossaryRows.map((row) => [
  field(row, [/原文|source/i]),
  field(row, [/读音|reading/i]),
  field(row, [/推荐译法|译法|target/i]),
  field(row, [/类型|category/i]),
  firstUrl(field(row, [/证据链接|evidence.*url/i, /证据|来源链接|evidence/i])),
  confidence(field(row, [/置信|confidence/i]) || "medium"),
  field(row, [/备注|notes?/i]),
]);

const pairRows = tableRows(parsedSections.get("角色—声优配对") || parsedSections.get("角色-声优配对") || []);
const colourRows = tableRows(parsedSections.get("角色与成员色") || []);
const speakerHeader = ["speaker_entity_id", "character_name", "performer_name", "speaking_as", "voice_traits", "evidence_url", "member_color", "color_hex", "color_scope", "color_source_url", "color_confidence"];
const speakers = pairRows.map((row) => {
  const character = field(row, [/^角色名$|character/i]);
  const characterKey = comparableName(character);
  const colour = colourRows.find((candidate) => {
    const name = comparableName(field(candidate, [/人物|成员|角色名|name/i]));
    return name && characterKey && (name === characterKey || name.includes(characterKey) || characterKey.includes(name));
  }) || {};
  return [
    field(row, [/人物实体|entity.*id/i]),
    character,
    field(row, [/声优|出演者|performer/i]),
    identity(field(row, [/发言身份|speaking/i])),
    "",
    firstUrl(field(row, [/证据链接|evidence.*url/i, /证据|来源链接|evidence/i])),
    field(colour, [/色名|颜色|colour|color name/i]),
    stripMarkdown(field(colour, [/^HEX$|hex/i])).match(/#[0-9a-f]{6}/i)?.[0] || "",
    colourScope(field(colour, [/适用身份|范围|scope/i])),
    firstUrl(field(colour, [/证据链接|evidence.*url/i, /证据|来源链接|evidence/i])),
    Object.keys(colour).length ? confidence(field(colour, [/置信|confidence/i])) : "low",
  ];
});

const artifacts = {
  brief: path.join(researchDirectory, "brief.md"),
  sources: path.join(researchDirectory, "sources.md"),
  glossary: path.join(researchDirectory, "glossary.tsv"),
  speakers: path.join(researchDirectory, "speakers.tsv"),
};
await Promise.all([
  writeFile(artifacts.brief, `${briefParts.join("\n\n")}\n`, "utf8"),
  writeFile(artifacts.sources, `${sourcesMarkdown.join("\n")}\n`, "utf8"),
  writeFile(artifacts.glossary, `${[glossaryHeader, ...glossary].map((row) => row.map(tsv).join("\t")).join("\n")}\n`, "utf8"),
  writeFile(artifacts.speakers, `${[speakerHeader, ...speakers].map((row) => row.map(tsv).join("\t")).join("\n")}\n`, "utf8"),
]);

process.stdout.write(`${JSON.stringify({ ok: true, preview: previewPath, artifacts, counts: { sources: uniqueSources.length, glossary: glossary.length, speakers: speakers.length } })}\n`);
