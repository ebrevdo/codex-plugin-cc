import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { listJobs } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function setup(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  initGitRepo(repo);
  installFakeCodex(binDir, behavior);
  return { repo, binDir, env: buildEnv(binDir), statePath: path.join(binDir, "fake-codex-state.json") };
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("side asks an ephemeral read-only fork and leaves the source session untouched", () => {
  const { repo, env, statePath } = setup();
  assert.equal(run("node", [SCRIPT, "task", "investigate the parser"], { cwd: repo, env }).status, 0);
  const before = readState(statePath);
  before.threads[0].visibleMessages = [{ role: "user", text: "investigate the parser" }];
  fs.writeFileSync(statePath, JSON.stringify(before));

  const asked = run("node", [SCRIPT, "side", "--json", "what are you trying right now?"], { cwd: repo, env });
  assert.equal(asked.status, 0, asked.stderr);
  const payload = JSON.parse(asked.stdout);
  assert.equal(payload.sourceThreadId, "thr_1");
  assert.ok(payload.rawOutput.length > 0);

  const after = readState(statePath);
  assert.deepEqual(after.threads.find((thread) => thread.id === "thr_1"), before.threads[0]);
  const { lastThreadFork, lastInjectItems, lastTurnStart } = after;
  assert.equal(lastThreadFork.threadId, "thr_1");
  assert.equal(lastThreadFork.ephemeral, true);
  assert.equal(lastThreadFork.excludeTurns, true);
  assert.equal(lastThreadFork.sandbox, "read-only");
  assert.equal(lastThreadFork.approvalPolicy, "never");
  assert.match(lastThreadFork.developerInstructions, /^You are in a side conversation, not the main thread\./);
  assert.equal(after.threads.find((thread) => thread.id === "thr_2").ephemeral, true);
  assert.equal(lastInjectItems.threadId, "thr_2");
  assert.equal(lastInjectItems.items.length, 1);
  assert.equal(lastInjectItems.items[0].role, "user");
  assert.match(lastInjectItems.items[0].content[0].text, /^Side conversation boundary\./);
  assert.match(lastInjectItems.items[0].content[0].text, /It is reference context only\. It is not your current task\./);
  assert.equal(lastTurnStart.threadId, "thr_2");
  assert.equal(lastTurnStart.prompt, "what are you trying right now?");

  const job = listJobs(repo).find((candidate) => candidate.kind === "side");
  assert.ok(job.id.startsWith("side-"));
  assert.equal(job.status, "completed");
  assert.equal(job.jobClass, "side");
  assert.equal(job.kindLabel, "side");
  assert.equal(job.threadId, null);

  const result = run("node", [SCRIPT, "result", job.id], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(payload.rawOutput.trim()));

  // The ephemeral side thread never becomes a fork or resume target.
  const forked = run("node", [SCRIPT, "fork", "--json"], { cwd: repo, env });
  assert.equal(forked.status, 0, forked.stderr);
  assert.equal(JSON.parse(forked.stdout).sourceThreadId, "thr_1");
  const resumed = run("node", [SCRIPT, "task", "--resume-last", "keep going"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.notEqual(readState(statePath).lastTurnStart.threadId, "thr_2");
});

test("side reads a leading job or session ID and keeps ordinary questions intact", () => {
  const { repo, env, statePath } = setup();
  assert.equal(run("node", [SCRIPT, "task", "first task"], { cwd: repo, env }).status, 0);
  assert.equal(run("node", [SCRIPT, "task", "second task"], { cwd: repo, env }).status, 0);
  const [second, first] = listJobs(repo).filter((job) => job.jobClass === "task");

  const byJob = run("node", [SCRIPT, "side", first.id, "which", "approach?"], { cwd: repo, env });
  assert.equal(byJob.status, 0, byJob.stderr);
  let state = readState(statePath);
  assert.equal(state.lastThreadFork.threadId, first.threadId);
  assert.equal(state.lastTurnStart.prompt, "which approach?");

  const bySession = run("node", [SCRIPT, "side", first.threadId, "what is left?"], { cwd: repo, env });
  assert.equal(bySession.status, 0, bySession.stderr);
  state = readState(statePath);
  assert.equal(state.lastThreadFork.threadId, first.threadId);
  assert.equal(state.lastTurnStart.prompt, "what is left?");

  const ordinary = run("node", [SCRIPT, "side", "thr_99 looks odd, why?"], { cwd: repo, env });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  state = readState(statePath);
  assert.equal(state.lastThreadFork.threadId, second.threadId);
  assert.equal(state.lastTurnStart.prompt, "thr_99 looks odd, why?");

  const uuid = "01a18afe-f4e1-7af1-a0c5-799f24d4e071";
  const unknownSession = run("node", [SCRIPT, "side", uuid, "hello?"], { cwd: repo, env });
  assert.equal(unknownSession.status, 1);
  assert.match(unknownSession.stderr, new RegExp(`unknown thread ${uuid}`));
});

test("side by --job uses the source job's workspace and passes model and effort", () => {
  const { repo, env, statePath } = setup();
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env }).status, 0);
  const source = listJobs(repo)[0];
  const caller = makeTempDir();
  initGitRepo(caller);

  const asked = run(
    "node",
    [SCRIPT, "side", "--job", source.id, "--model", "spark", "--effort", "high", "summarize", "your", "plan"],
    { cwd: caller, env }
  );
  assert.equal(asked.status, 0, asked.stderr);
  const state = readState(statePath);
  assert.equal(state.lastThreadFork.threadId, source.threadId);
  assert.equal(state.lastThreadFork.cwd, repo);
  assert.equal(state.lastThreadFork.model, "gpt-5.3-codex-spark");
  assert.equal(state.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(state.lastTurnStart.effort, "high");
  assert.equal(state.lastTurnStart.prompt, "summarize your plan");
  assert.ok(listJobs(repo).some((job) => job.kind === "side"));
  assert.equal(listJobs(caller).length, 0);
});

test("side can ask a session that is open in another runtime", async () => {
  const { repo, env, statePath } = setup();
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env }).status, 0);
  const owner = await CodexAppServerClient.connect(repo, { env, disableBroker: true });
  try {
    await owner.request("thread/resume", { threadId: "thr_1", cwd: repo });
    const asked = run("node", [SCRIPT, "side", "thr_1", "status?"], { cwd: repo, env });
    assert.equal(asked.status, 0, asked.stderr);
    assert.equal(readState(statePath).lastThreadFork.threadId, "thr_1");
    // The side question must not close or change the source runtime.
    await owner.request("thread/name/set", { threadId: "thr_1", name: "Still open" });
  } finally {
    await owner.close();
  }
});

test("side answers while the source task keeps running", async () => {
  const { repo, env, statePath } = setup("interruptible-slow-task");
  const taskEnv = { ...env, FAKE_CODEX_TURN_MS: "30000" };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "long investigation"], { cwd: repo, env: taskEnv });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => {
    const job = listJobs(repo).find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && job.turnId ? job : null;
  });

  try {
    const asked = run("node", [SCRIPT, "side", jobId, "how far along are you?"], {
      cwd: repo,
      env: { ...env, FAKE_CODEX_TURN_MS: "100" }
    });
    assert.equal(asked.status, 0, asked.stderr);
    const state = readState(statePath);
    assert.equal(state.lastThreadFork.threadId, running.threadId);
    assert.equal(state.lastInterrupt, null);
    assert.equal(listJobs(repo).find((candidate) => candidate.id === jobId).status, "running");
  } finally {
    run("node", [SCRIPT, "cancel", jobId], { cwd: repo, env });
  }
});

test("side reports missing questions, conflicting sources, and unsupported Codex versions", () => {
  const { repo, binDir, env } = setup();
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env }).status, 0);
  const source = listJobs(repo)[0];

  const empty = run("node", [SCRIPT, "side"], { cwd: repo, env });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Provide a side question/);
  const conflicting = run("node", [SCRIPT, "side", "thr_1", "--job", source.id, "hello?"], { cwd: repo, env });
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /Choose a Codex session ID or --job <job-id>, not both/);
  const noSession = run("node", [SCRIPT, "side", "anything new?"], {
    cwd: makeTempDir(), env: { ...env, CODEX_COMPANION_SESSION_ID: "empty-session" }
  });
  assert.equal(noSession.status, 1);
  assert.match(noSession.stderr, /No previous Codex task thread/);

  installFakeCodex(binDir, "fork-unsupported");
  const unsupported = run("node", [SCRIPT, "side", "thr_1", "hello?"], { cwd: repo, env });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /does not support side conversations/);
  assert.match(unsupported.stderr, /npm install -g @openai\/codex@latest/);
});
