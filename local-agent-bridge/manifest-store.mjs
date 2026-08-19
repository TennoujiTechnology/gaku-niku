import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const queues = new Map();
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

async function acquireLock(file) {
  const lock = `${file}.writer-lock`;
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lock);
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(lock).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Manifest 写入器等待超时：${path.basename(file)}`);
      await delay(25);
    }
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function enqueue(file, operation) {
  const key = path.resolve(file);
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  const cleanup = () => {
    if (queues.get(key) === current) queues.delete(key);
  };
  current.then(cleanup, cleanup);
  return current;
}

export function writeJsonAtomic(file, value) {
  return enqueue(file, async () => {
    const lock = await acquireLock(file);
    try {
      await atomicWrite(file, value);
      return value;
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export function updateJsonAtomic(file, updater, fallback = {}) {
  return enqueue(file, async () => {
    const lock = await acquireLock(file);
    try {
      const current = await readJson(file, fallback);
      const next = await updater(structuredClone(current));
      if (!next || typeof next !== "object") throw new Error("Manifest 更新器必须返回对象");
      await atomicWrite(file, next);
      return next;
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export function applyMergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const output = target && typeof target === "object" && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? applyMergePatch(output[key], value)
      : structuredClone(value);
  }
  return output;
}
