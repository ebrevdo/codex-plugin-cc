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

test("fork copies the latest task without starting a turn and rescue resumes the copy", () => {
  const { repo, env, statePath } = setup();
  const initial = run("node", [SCRIPT, "task", "investigate the parser"], { cwd: repo, env });
  assert.equal(initial.status, 0, initial.stderr);
  const before = JSON.parse(fs.readFileSync(statePath, "utf8"));
  before.threads[0].visibleMessages = [{ role: "user", text: "investigate the parser" }];
  fs.writeFileSync(statePath, JSON.stringify(before));

  const forked = run("node", [SCRIPT, "fork", "--json"], { cwd: repo, env });
  assert.equal(forked.status, 0, forked.stderr);
  const payload = JSON.parse(forked.stdout);
  const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(after.nextTurnId, before.nextTurnId);
  assert.deepEqual(after.threads.find((thread) => thread.id === "thr_1"), before.threads[0]);
  assert.deepEqual(after.threads[0].visibleMessages, before.threads[0].visibleMessages);
  assert.equal(after.threads[0].ephemeral, false);
  const job = listJobs(repo).find((job) => job.threadId === payload.threadId);
  assert.deepEqual(payload, { jobId: job.id, sourceThreadId: "thr_1", threadId: "thr_2", resumeCommand: "codex resume thr_2" });
  assert.equal(job.status, "completed");
  assert.equal(job.jobClass, "task");

  const result = run("node", [SCRIPT, "result", job.id], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_2/);
  assert.equal(result.stdout.match(/Codex session ID:/g).length, 1);
  const resumed = run("node", [SCRIPT, "task", "--resume", "try another approach"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  const final = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(final.lastTurnStart.threadId, "thr_2");
  assert.deepEqual(final.threads.find((thread) => thread.id === "thr_1"), before.threads[0]);
});

test("fork uses the source job's workspace and honors saved plugin options", () => {
  const { repo, env, statePath } = setup();
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env }).status, 0);
  const source = listJobs(repo)[0];
  const caller = makeTempDir();
  initGitRepo(caller);

  const fromElsewhere = run("node", [SCRIPT, "fork", "--job", source.id, "--json"], { cwd: caller, env });
  assert.equal(fromElsewhere.status, 0, fromElsewhere.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastThreadFork.cwd, repo);
  assert.ok(listJobs(repo).some((job) => job.threadId === JSON.parse(fromElsewhere.stdout).threadId));
  assert.equal(listJobs(caller).length, 0);

  const target = makeTempDir();
  initGitRepo(target);
  const workspaceRoot = path.join(target, "workspace with spaces");
  fs.mkdirSync(workspaceRoot);
  const configDir = makeTempDir();
  const codexHome = path.join(makeTempDir(), "codex home");
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    pluginConfigs: { "codex@openai-codex": { options: {
      codex_home: codexHome, workspace_root: workspaceRoot, fast_mode: true, auto_review: true
    } } }
  }));
  const configured = run("node", [SCRIPT, "fork", "--job", source.id, "--cwd", repo, "--model", "spark", "--json"], {
    cwd: caller, env: { ...env, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: makeTempDir() }
  });
  assert.equal(configured.status, 0, configured.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.lastThreadFork, {
    threadId: source.threadId,
    cwd: workspaceRoot,
    model: "gpt-5.3-codex-spark",
    serviceTier: "fast",
    config: { "features.fast_mode": true },
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "read-only",
    ephemeral: false,
    codexHome
  });
  assert.ok(listJobs(target).some((job) => job.threadId === JSON.parse(configured.stdout).threadId));
});

test("fork's printed continuation resumes the copy from another repository", () => {
  const { repo, env, statePath } = setup();
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env }).status, 0);
  const source = listJobs(repo)[0];

  for (const hasLocalTask of [false, true]) {
    const caller = makeTempDir();
    initGitRepo(caller);
    if (hasLocalTask) {
      assert.equal(run("node", [SCRIPT, "task", "unrelated local task"], { cwd: caller, env }).status, 0);
    }

    const forked = run("node", [SCRIPT, "fork", "--job", source.id], { cwd: caller, env });
    assert.equal(forked.status, 0, forked.stderr);
    const continuation = forked.stdout.match(/^Continue with (\/codex:rescue --resume-job (task-\S+))$/m);
    assert.ok(continuation, "print a continuation command that targets the new fork job");
    const [, command, jobId] = continuation;
    const forkJob = listJobs(repo).find((job) => job.id === jobId);
    assert.ok(forkJob);
    assert.notEqual(jobId, source.id);
    assert.notEqual(forkJob.threadId, source.threadId);
    assert.ok(forked.stdout.includes(`Job: ${jobId}\n`));

    const stored = run("node", [SCRIPT, "result", jobId], { cwd: caller, env });
    assert.equal(stored.status, 0, stored.stderr);
    assert.ok(stored.stdout.includes(command));
    const resumed = run("node", [SCRIPT, "task", ...command.split(" ").slice(1), "try another approach"], {
      cwd: caller, env
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.lastTurnStart.threadId, forkJob.threadId);
    assert.equal(state.lastTurnStart.cwd, repo);
    assert.equal(listJobs(caller).length, hasLocalTask ? 1 : 0);
  }
});

test("fork clears fast mode and auto-review when plugin options are disabled", () => {
  const { repo, env, statePath } = setup();
  const fastEnv = { ...env, CODEX_COMPANION_FAST_MODE: "true", CODEX_COMPANION_AUTO_REVIEW: "true" };
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: fastEnv }).status, 0);
  const forked = run("node", [SCRIPT, "fork", "thr_1"], {
    cwd: repo,
    env: { ...fastEnv, CLAUDE_PLUGIN_OPTION_FAST_MODE: "false", CLAUDE_PLUGIN_OPTION_AUTO_REVIEW: "false" }
  });
  assert.equal(forked.status, 0, forked.stderr);
  assert.match(forked.stdout, /Codex session ID: thr_2/);
  const { lastThreadFork } = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(lastThreadFork.serviceTier, null);
  assert.deepEqual(lastThreadFork.config, { "features.fast_mode": false });
  assert.equal(lastThreadFork.approvalPolicy, "never");
  assert.equal(lastThreadFork.approvalsReviewer, null);
});

test("fork can copy a session that is open in another runtime", async () => {
  const { repo, env } = setup();
  const owner = await CodexAppServerClient.connect(repo, { env, disableBroker: true });
  try {
    const { thread } = await owner.request("thread/start", { cwd: repo, ephemeral: false });
    const forked = run("node", [SCRIPT, "fork", thread.id, "--json"], { cwd: repo, env });
    assert.equal(forked.status, 0, forked.stderr);
    assert.notEqual(JSON.parse(forked.stdout).threadId, thread.id);
    // The fork must not close or change the source runtime.
    await owner.request("thread/name/set", { threadId: thread.id, name: "Still open" });
  } finally {
    await owner.close();
  }
});

test("fork without an ID only selects tasks from the current Claude session", () => {
  const { repo, env } = setup();
  const sessionEnv = { ...env, CODEX_COMPANION_SESSION_ID: "fork-session" };
  assert.equal(run("node", [SCRIPT, "task", "first session"], { cwd: repo, env: sessionEnv }).status, 0);
  assert.equal(run("node", [SCRIPT, "task", "other session"], {
    cwd: repo, env: { ...env, CODEX_COMPANION_SESSION_ID: "other-session" }
  }).status, 0);
  const forked = run("node", [SCRIPT, "fork", "--json"], { cwd: repo, env: sessionEnv });
  assert.equal(forked.status, 0, forked.stderr);
  assert.equal(JSON.parse(forked.stdout).sourceThreadId, "thr_1");
  const missing = run("node", [SCRIPT, "fork"], {
    cwd: repo, env: { ...env, CODEX_COMPANION_SESSION_ID: "empty-session" }
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No previous Codex task thread/);
});

test("fork reports conflicting inputs, missing threads, and unsupported Codex versions", () => {
  const { repo, binDir, env } = setup();
  const conflicting = run("node", [SCRIPT, "fork", "thr_1", "--job", "task-source"], { cwd: repo, env });
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /Choose a Codex session ID or --job/);
  const missing = run("node", [SCRIPT, "fork", "thr_missing"], { cwd: repo, env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /unknown thread thr_missing/);
  installFakeCodex(binDir, "fork-unsupported");
  const unsupported = run("node", [SCRIPT, "fork", "thr_1"], { cwd: repo, env });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /does not support session forking/);
  assert.match(unsupported.stderr, /npm install -g @openai\/codex@latest/);
});
