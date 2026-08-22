import { spawnSync } from "node:child_process";
import os from "node:os";
import { open, rename, rm, stat } from "node:fs/promises";
import { Writable } from "node:stream";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function jobResourcePolicy(env = process.env, totalMemoryBytes = os.totalmem()) {
  const automaticMemoryLimit = Math.min(6 * GIB, Math.max(3 * GIB, Math.floor(totalMemoryBytes * 0.42)));
  return {
    maxConcurrentJobs: boundedInteger(env.PSS_MAX_ACTIVE_JOBS, 1, 1, 2),
    memoryLimitBytes: boundedInteger(env.PSS_JOB_MEMORY_LIMIT_MB, Math.round(automaticMemoryLimit / MIB), 1024, 32 * 1024) * MIB,
    idleTimeoutMs: boundedInteger(env.PSS_JOB_IDLE_TIMEOUT_MINUTES, 10, 1, 120) * 60_000,
    hardTimeoutMs: boundedInteger(env.PSS_JOB_HARD_TIMEOUT_HOURS, 8, 1, 48) * 60 * 60_000,
    monitorIntervalMs: boundedInteger(env.PSS_JOB_MONITOR_SECONDS, 15, 2, 120) * 1000,
    stdoutLogBytes: boundedInteger(env.PSS_STDOUT_LOG_LIMIT_MB, 32, 4, 256) * MIB,
    stderrLogBytes: boundedInteger(env.PSS_STDERR_LOG_LIMIT_MB, 8, 1, 64) * MIB,
    logBackups: boundedInteger(env.PSS_LOG_BACKUPS, 2, 1, 4),
  };
}

class RotatingLogWriter extends Writable {
  constructor(file, options = {}) {
    super({ decodeStrings: true });
    this.file = file;
    this.maxBytes = Math.max(1024, Number(options.maxBytes || 32 * MIB));
    this.backups = Math.max(1, Number(options.backups || 2));
    this.handle = null;
    this.bytes = 0;
    this.ready = this.initialize();
  }

  async initialize() {
    this.bytes = Number((await stat(this.file).catch(() => ({ size: 0 }))).size || 0);
    if (this.bytes >= this.maxBytes) await this.rotate();
    else this.handle = await open(this.file, "a");
  }

  async rotate() {
    if (this.handle) await this.handle.close().catch(() => {});
    this.handle = null;
    await rm(`${this.file}.${this.backups}`, { force: true }).catch(() => {});
    for (let index = this.backups - 1; index >= 1; index -= 1) {
      await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch(() => {});
    }
    await rename(this.file, `${this.file}.1`).catch(() => {});
    this.handle = await open(this.file, "a");
    this.bytes = 0;
  }

  _write(chunk, encoding, callback) {
    (async () => {
      await this.ready;
      let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (data.length > this.maxBytes) data = data.subarray(data.length - this.maxBytes);
      if (this.bytes > 0 && this.bytes + data.length > this.maxBytes) await this.rotate();
      await this.handle.write(data);
      this.bytes += data.length;
    })().then(() => callback(), callback);
  }

  _final(callback) {
    this.ready.then(async () => {
      if (this.handle) await this.handle.close().catch(() => {});
      this.handle = null;
    }).then(() => callback(), callback);
  }

  _destroy(error, callback) {
    this.ready.catch(() => {}).then(async () => {
      if (this.handle) await this.handle.close().catch(() => {});
      this.handle = null;
    }).finally(() => callback(error));
  }
}

export function createRotatingLogStream(file, options = {}) {
  return new RotatingLogWriter(file, options);
}

export function processTreeSnapshot(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = options.platform || process.platform;
  const rows = new Map();
  const children = new Map();
  if (platform === "win32") {
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress"], {
      encoding: "utf8",
      timeout: Number(options.timeoutMs || 5000),
      maxBuffer: 4 * MIB,
      windowsHide: true,
    });
    if (probe.status !== 0 || !probe.stdout) return null;
    let parsed;
    try { parsed = JSON.parse(probe.stdout); } catch { return null; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const row = { pid: Number(item.ProcessId), ppid: Number(item.ParentProcessId), rssBytes: Number(item.WorkingSetSize || 0), cpuPercent: 0 };
      if (Number.isInteger(row.pid) && row.pid > 0) rows.set(row.pid, row);
    }
  } else {
    const probe = spawnSync("ps", ["-Ao", "pid=,ppid=,rss=,%cpu="], {
      encoding: "utf8",
      timeout: Number(options.timeoutMs || 3000),
      maxBuffer: 2 * MIB,
    });
    if (probe.status !== 0 || !probe.stdout) return null;
    for (const line of String(probe.stdout).split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)$/);
      if (!match) continue;
      const row = { pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, cpuPercent: Number(match[4]) };
      rows.set(row.pid, row);
    }
  }
  for (const row of rows.values()) {
    const siblings = children.get(row.ppid) || [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  if (!rows.has(pid)) return null;
  const pids = [];
  const visit = (current) => {
    pids.push(current);
    for (const child of children.get(current) || []) visit(child);
  };
  visit(pid);
  const unique = [...new Set(pids)];
  return unique.reduce((summary, current) => {
    const row = rows.get(current);
    if (!row) return summary;
    summary.rssBytes += row.rssBytes;
    summary.cpuPercent += row.cpuPercent;
    return summary;
  }, { pids: unique, processCount: unique.length, rssBytes: 0, cpuPercent: 0 });
}
