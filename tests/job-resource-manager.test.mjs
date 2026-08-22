import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import { createRotatingLogStream, jobResourcePolicy, processTreeSnapshot } from "../local-agent-bridge/job-resource-manager.mjs";

test("resource policy defaults to one bounded job on a 16 GB machine", () => {
  const policy = jobResourcePolicy({}, 16 * 1024 ** 3);
  assert.equal(policy.maxConcurrentJobs, 1);
  assert.equal(policy.memoryLimitBytes, 6 * 1024 ** 3);
  assert.equal(policy.idleTimeoutMs, 10 * 60_000);
  assert.equal(policy.hardTimeoutMs, 8 * 60 * 60_000);
  assert.equal(policy.stdoutLogBytes, 32 * 1024 ** 2);
  assert.equal(policy.stderrLogBytes, 8 * 1024 ** 2);
});

test("resource policy accepts bounded deployment overrides", () => {
  const policy = jobResourcePolicy({
    PSS_MAX_ACTIVE_JOBS: "9",
    PSS_JOB_MEMORY_LIMIT_MB: "4096",
    PSS_JOB_IDLE_TIMEOUT_MINUTES: "5",
    PSS_STDOUT_LOG_LIMIT_MB: "12",
  }, 16 * 1024 ** 3);
  assert.equal(policy.maxConcurrentJobs, 2);
  assert.equal(policy.memoryLimitBytes, 4096 * 1024 ** 2);
  assert.equal(policy.idleTimeoutMs, 5 * 60_000);
  assert.equal(policy.stdoutLogBytes, 12 * 1024 ** 2);
});

test("rotating logs retain bounded current and previous files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gakuniku-log-"));
  const file = path.join(directory, "agent.ndjson");
  const stream = createRotatingLogStream(file, { maxBytes: 1024, backups: 2 });
  stream.write(Buffer.alloc(800, "a"));
  stream.end(Buffer.alloc(800, "b"));
  await finished(stream);
  assert.equal((await readFile(file)).length, 800);
  assert.equal((await readFile(`${file}.1`)).length, 800);
});

test("process tree snapshot includes the current process", { skip: process.platform === "win32" }, () => {
  const snapshot = processTreeSnapshot(process.pid);
  assert.ok(snapshot);
  assert.ok(snapshot.pids.includes(process.pid));
  assert.ok(snapshot.processCount >= 1);
  assert.ok(snapshot.rssBytes > 0);
});
