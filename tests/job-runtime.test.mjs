import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, spawnCompanionSleeper as spawnSleeper } from "./helpers.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import {
  computeBrokerBuildId,
  ensureBrokerSession,
  loadBrokerSession,
  queryBrokerStatus,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(ROOT, "plugins", "codex", "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
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

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return !/^\S+ \(.*\) [ZX]/.test(stat);
    } catch {
      return false;
    }
  }
  return true;
}

function killQuietly(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// Test files run in parallel and share one state root, so ids that span workspaces must be unique.
function uniqueId(prefix) {
  return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function setupRepo(behavior = "review-ok", extraEnv = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return {
    repo,
    binDir,
    env: { ...buildEnv(binDir), ...extraEnv },
    fakeStatePath: path.join(binDir, "fake-codex-state.json")
  };
}

function readState(workspace) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "state.json"), "utf8"));
}

function writeState(workspace, jobs) {
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );
  return stateDir;
}

async function launchBackgroundTasks(repo, env, prompts) {
  const launches = await Promise.all(
    prompts.map((prompt) => runAsync("node", [SCRIPT, "task", "--background", "--json", prompt], { cwd: repo, env }))
  );
  for (const launch of launches) {
    assert.equal(launch.status, 0, launch.stderr);
  }
  const jobIds = launches.map((launch) => JSON.parse(launch.stdout).jobId);
  const jobs = await waitFor(
    () => {
      const state = readState(repo);
      const found = jobIds.map((id) => state.jobs.find((job) => job.id === id));
      return found.every((job) => job?.status === "running" && job.turnId && job.controlEndpoint) ? found : null;
    },
    { timeoutMs: 20000 }
  );
  return jobs;
}

test("concurrent background tasks in one workspace each run on their own steerable, cancellable runtime", async (t) => {
  const { repo, env } = setupRepo("interruptible-slow-task", { FAKE_CODEX_TURN_MS: "30000" });
  const jobs = await launchBackgroundTasks(repo, env, ["investigate the parser", "investigate the lexer"]);
  t.after(() => {
    for (const job of jobs) {
      run("node", [SCRIPT, "cancel", job.id], { cwd: repo, env });
    }
  });

  assert.deepEqual(
    jobs.map((job) => job.transport),
    ["job", "job"]
  );
  assert.notEqual(jobs[0].controlEndpoint, jobs[1].controlEndpoint);
  assert.notEqual(jobs[0].threadId, jobs[1].threadId);

  for (const job of jobs) {
    const steer = run("node", [SCRIPT, "steer", job.id, "--json", `focus on ${job.id}`], { cwd: repo, env });
    assert.equal(steer.status, 0, steer.stderr);
    const payload = JSON.parse(steer.stdout);
    assert.equal(payload.steered, true, payload.detail);
    assert.match(fs.readFileSync(job.logFile, "utf8"), new RegExp(`Steered turn ${job.turnId}: focus on ${job.id}`));
  }

  const cancelFirst = run("node", [SCRIPT, "cancel", jobs[0].id, "--json"], { cwd: repo, env });
  assert.equal(cancelFirst.status, 0, cancelFirst.stderr);
  assert.equal(JSON.parse(cancelFirst.stdout).turnInterrupted, true);
  assert.doesNotMatch(fs.readFileSync(jobs[0].logFile, "utf8"), /thread not found|busy/i);

  // The other job keeps running on its own runtime and can still be steered and cancelled.
  assert.equal(readState(repo).jobs.find((job) => job.id === jobs[1].id).status, "running");
  const steerSecond = run("node", [SCRIPT, "steer", jobs[1].id, "--json", "wrap up"], { cwd: repo, env });
  assert.equal(JSON.parse(steerSecond.stdout).steered, true);
  const cancelSecond = run("node", [SCRIPT, "cancel", jobs[1].id, "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(cancelSecond.stdout).turnInterrupted, true);
  assert.deepEqual(
    readState(repo).jobs.map((job) => job.status),
    ["cancelled", "cancelled"]
  );
});

test("cancel stops every process a job's turn left running, and only that job's", async (t) => {
  const { repo, env, binDir } = setupRepo("background-processes");
  const jobs = await launchBackgroundTasks(repo, env, ["replay the campaign", "replay the other campaign"]);
  const names = ["command", "worker", "daemon"];
  const pidsOf = (job) =>
    names.map((name) => Number.parseInt(fs.readFileSync(path.join(binDir, `procs-${job.turnId}`, name), "utf8"), 10));
  await waitFor(() => jobs.every((job) => names.every((name) => fs.existsSync(path.join(binDir, `procs-${job.turnId}`, name)))));
  const [firstPids, secondPids] = jobs.map(pidsOf);
  t.after(() => {
    for (const job of jobs) {
      run("node", [SCRIPT, "cancel", job.id], { cwd: repo, env });
    }
    [...firstPids, ...secondPids].forEach(killQuietly);
  });
  assert.ok([...firstPids, ...secondPids].every(isAlive));

  const cancelFirst = run("node", [SCRIPT, "cancel", jobs[0].id, "--json"], { cwd: repo, env });
  assert.equal(cancelFirst.status, 0, cancelFirst.stderr);
  assert.ok(JSON.parse(cancelFirst.stdout).processesStopped >= 3);

  // The command and its worker were in their own process group below the job's app server. The daemon had
  // detached from it entirely; only the job's environment marker (Linux) still ties it to the job.
  const expectedGone = process.platform === "linux" ? firstPids : firstPids.slice(0, 2);
  await waitFor(() => expectedGone.every((pid) => !isAlive(pid)), { timeoutMs: 5000 });
  assert.ok(secondPids.every(isAlive), "the other job's processes must keep running");
  assert.match(fs.readFileSync(jobs[0].logFile, "utf8"), /Stopped \d+ process\(es\) started by the job/);

  const cancelSecond = run("node", [SCRIPT, "cancel", jobs[1].id, "--json"], { cwd: repo, env });
  assert.equal(cancelSecond.status, 0, cancelSecond.stderr);
  const secondExpectedGone = process.platform === "linux" ? secondPids : secondPids.slice(0, 2);
  await waitFor(() => secondExpectedGone.every((pid) => !isAlive(pid)), { timeoutMs: 5000 });
});

test("cancel and session end leave an unrelated process at a stale job PID running", async (t) => {
  const repo = makeTempDir();
  const sessionId = uniqueId("sess-stale");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: repo, stdio: "ignore" });
  t.after(() => killQuietly(sleeper.pid));
  const job = {
    id: uniqueId("task-stale"),
    sessionId,
    workspaceRoot: repo,
    status: "running",
    jobClass: "task",
    pid: sleeper.pid
  };
  writeState(repo, [job]);

  const cancel = run("node", [SCRIPT, "cancel", job.id, "--json"], { cwd: repo });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).processesStopped, 0);
  assert.ok(isAlive(sleeper.pid), "a stale job PID must not terminate an unrelated process");

  writeState(repo, [job]);
  const end = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({ session_id: sessionId, cwd: repo })
  });
  assert.equal(end.status, 0, end.stderr);
  assert.ok(isAlive(sleeper.pid), "session cleanup must also leave the unrelated process running");
  assert.deepEqual(readState(repo).jobs, []);
});

test("the shared broker delivers steer and interrupt while another client streams and has a request in flight", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  const session = await ensureBrokerSession(repo, { env: { ...buildEnv(binDir), FAKE_CODEX_TURN_MS: "30000" } });
  assert.ok(session, "broker should start");

  const owner = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
  const other = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
  try {
    const { thread } = await owner.request("thread/start", { cwd: repo, ephemeral: true });
    const { turn } = await owner.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "work", text_elements: [] }]
    });
    const ownerRequest = owner.request("test/delay", { ms: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    await other.request("turn/steer", {
      threadId: thread.id,
      expectedTurnId: turn.id,
      input: [{ type: "text", text: "focus", text_elements: [] }]
    });
    // Anything else from another client still waits for the turn to finish.
    await assert.rejects(other.request("thread/list", {}), (error) => error.rpcCode === BROKER_BUSY_RPC_CODE);
    await other.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    await ownerRequest;
  } finally {
    await owner.close();
    await other.close();
  }
});

function startFakeOldBroker(sessionDir, statusReply) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const message = JSON.parse(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        requests.push(message.method);
        if (message.method === "broker/shutdown") {
          socket.end(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          server.close();
        } else {
          socket.write(`${JSON.stringify({ id: message.id, ...statusReply })}\n`);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(path.join(sessionDir, "broker.sock"), () => resolve({ server, requests })));
}

test("a broker still running older plugin code is replaced once idle, but kept while busy", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  // An older broker forwards the unknown broker/status to Codex when idle, which rejects it.
  const idleRepo = makeTempDir();
  const idleDir = makeTempDir("cxc-old-");
  const idleEndpoint = `unix:${path.join(idleDir, "broker.sock")}`;
  const idle = await startFakeOldBroker(idleDir, { error: { code: -32601, message: "Unsupported method: broker/status" } });
  saveBrokerSession(idleRepo, { endpoint: idleEndpoint, sessionDir: idleDir, pidFile: null, logFile: null, pid: null });

  const replaced = await ensureBrokerSession(idleRepo, { env: buildEnv(binDir) });
  assert.ok(replaced.endpoint && replaced.endpoint !== idleEndpoint);
  assert.ok(idle.requests.includes("broker/shutdown"));
  const status = await queryBrokerStatus(replaced.endpoint);
  assert.equal(status.buildId, computeBrokerBuildId());
  assert.equal(status.busy, false);

  // While another client is streaming through it, it answers busy and must be left alone.
  const busyRepo = makeTempDir();
  const busyDir = makeTempDir("cxc-old-");
  const busyEndpoint = `unix:${path.join(busyDir, "broker.sock")}`;
  const busy = await startFakeOldBroker(busyDir, { error: { code: BROKER_BUSY_RPC_CODE, message: "Shared Codex broker is busy." } });
  saveBrokerSession(busyRepo, { endpoint: busyEndpoint, sessionDir: busyDir, pidFile: null, logFile: null, pid: null });
  try {
    const kept = await ensureBrokerSession(busyRepo, { env: buildEnv(binDir) });
    assert.equal(kept.endpoint, busyEndpoint);
    assert.ok(!busy.requests.includes("broker/shutdown"));
  } finally {
    busy.server.close();
  }
});

test("a shared broker nobody uses shuts itself down and removes its files", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const session = await ensureBrokerSession(repo, {
    env: { ...buildEnv(binDir), CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "300" }
  });
  assert.ok(session);
  await waitFor(() => !fs.existsSync(session.sessionDir) && !isAlive(session.pid), { timeoutMs: 10000 });
});

test("task --resume-last continues the newest finished task while an unrelated task is running", () => {
  const { repo, env, fakeStatePath } = setupRepo();
  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const state = readState(repo);
  writeState(repo, [
    {
      id: "task-other-running",
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      threadId: "thr_other",
      workspaceRoot: repo,
      updatedAt: new Date(Date.now() + 60000).toISOString()
    },
    ...state.jobs
  ]);

  const resumed = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --resume-job and --resume-thread continue a specific thread, not just the newest", () => {
  const { repo, env, fakeStatePath } = setupRepo();
  assert.equal(run("node", [SCRIPT, "task", "first task"], { cwd: repo, env }).status, 0);
  assert.equal(run("node", [SCRIPT, "task", "second task"], { cwd: repo, env }).status, 0);
  const firstJob = readState(repo).jobs.find((job) => job.threadId === "thr_1");
  assert.ok(firstJob);

  const byJob = run("node", [SCRIPT, "task", "--resume-job", firstJob.id, "follow up on the first"], { cwd: repo, env });
  assert.equal(byJob.status, 0, byJob.stderr);
  let fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual([fakeState.lastTurnStart.threadId, fakeState.lastTurnStart.prompt], ["thr_1", "follow up on the first"]);

  const byThread = run("node", [SCRIPT, "task", "--resume-thread", "thr_2", "follow up on the second"], { cwd: repo, env });
  assert.equal(byThread.status, 0, byThread.stderr);
  fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual([fakeState.lastTurnStart.threadId, fakeState.lastTurnStart.prompt], ["thr_2", "follow up on the second"]);

  const conflicting = run("node", [SCRIPT, "task", "--resume-job", firstJob.id, "--fresh", "x"], { cwd: repo, env });
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /Choose only one of/);
});

test("resuming a job from another repository keeps its source workspace in foreground and background", async (t) => {
  const { repo: source, env, fakeStatePath } = setupRepo();
  const caller = makeTempDir();
  initGitRepo(caller);
  const initial = run("node", [SCRIPT, "task", "initial task"], { cwd: source, env });
  assert.equal(initial.status, 0, initial.stderr);
  const originalJob = readState(source).jobs[0];

  for (const background of [false, true]) {
    const before = new Set(readState(source).jobs.map((job) => job.id));
    const resumed = run("node", [SCRIPT, "task", "--resume-job", originalJob.id, "--write", "--json",
      ...(background ? ["--background"] : []), "continue in the source checkout"], { cwd: caller, env });
    assert.equal(resumed.status, 0, resumed.stderr);
    const jobId = background ? JSON.parse(resumed.stdout).jobId : readState(source).jobs.find((job) => !before.has(job.id))?.id;
    if (background) {
      t.after(() => run("node", [SCRIPT, "cancel", jobId], { cwd: caller, env }));
    }
    assert.ok(jobId, "the resumed job must be tracked in the source workspace");
    assert.ok(readState(source).jobs.some((job) => job.id === jobId));
    const completed = await waitForJob(source, jobId);
    assert.equal(completed.workspaceRoot, source);
    assert.equal(completed.write, true);
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal(state.lastTurnStart.threadId, originalJob.threadId);
    assert.equal(state.lastTurnStart.cwd, source);
    assert.equal(fs.existsSync(path.join(resolveStateDir(caller), "state.json")), false);
  }
});

test("workspace_root overrides new and resumed sessions, including background jobs and reviews", async (t) => {
  const { repo: source, env, fakeStatePath } = setupRepo();
  const { repo: target } = setupRepo();
  const caller = makeTempDir();
  const configuredRoot = path.join(target, "workspace with spaces");
  fs.mkdirSync(configuredRoot);
  const initial = run("node", [SCRIPT, "task", "initial task"], { cwd: source, env });
  assert.equal(initial.status, 0, initial.stderr);
  const originalJob = readState(source).jobs[0];
  const configDir = makeTempDir();
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    pluginConfigs: { "codex@openai-codex": { options: { workspace_root: configuredRoot } } }
  }));
  const configuredEnv = { ...env, CLAUDE_CONFIG_DIR: configDir };
  const setup = run("node", [SCRIPT, "setup", "--json"], { cwd: caller, env: configuredEnv });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).workspaceRoot, configuredRoot);
  writeState(target, []);

  const resumedLast = run("node", [SCRIPT, "task", "--resume", "--write", "--json", "continue in the configured checkout"], {
    cwd: source, env: configuredEnv
  });
  assert.equal(resumedLast.status, 0, resumedLast.stderr);
  const resumedState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(resumedState.lastTurnStart.threadId, originalJob.threadId);
  assert.equal(resumedState.lastTurnStart.cwd, configuredRoot);

  for (const resume of [false, true]) {
    for (const background of [false, true]) {
      const before = new Set(readState(target).jobs.map((job) => job.id));
      const launched = run("node", [SCRIPT, "task", "--cwd", source, "--write", "--json",
        ...(resume ? ["--resume-job", originalJob.id] : ["--fresh"]),
        ...(background ? ["--background"] : []), "use the configured workspace"], { cwd: caller, env: configuredEnv });
      assert.equal(launched.status, 0, launched.stderr);
      const jobId = background ? JSON.parse(launched.stdout).jobId : readState(target).jobs.find((job) => !before.has(job.id))?.id;
      if (background) {
        t.after(() => run("node", [SCRIPT, "cancel", jobId], { cwd: caller, env: configuredEnv }));
      }
      assert.ok(jobId, "the task must be tracked in the configured workspace");
      const completed = await waitForJob(target, jobId);
      assert.equal(completed.workspaceRoot, target);
      const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      assert.equal(state.lastTurnStart.cwd, configuredRoot);
      if (resume) {
        assert.equal(state.lastTurnStart.threadId, originalJob.threadId);
      }
      const result = run("node", [SCRIPT, "result", "--json"], { cwd: caller, env: configuredEnv });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).job.id, jobId);
    }
  }

  fs.appendFileSync(path.join(target, "README.md"), "review this change\n");
  for (const command of ["review", "adversarial-review"]) {
    const review = run("node", [SCRIPT, command, "--wait"], { cwd: caller, env: configuredEnv });
    assert.equal(review.status, 0, review.stderr);
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal(state.threads.at(-1).cwd, configuredRoot);
  }
  assert.equal(readState(source).jobs.length, 1, "an explicit override must not create jobs in the source repository");
});

test("task refuses to resume a thread that a running job is still using", () => {
  const { repo, env } = setupRepo();
  assert.equal(run("node", [SCRIPT, "task", "first task"], { cwd: repo, env }).status, 0);
  const finished = readState(repo).jobs[0];
  writeState(repo, [
    {
      id: "task-busy",
      status: "running",
      title: "Codex Resume",
      jobClass: "task",
      threadId: finished.threadId,
      workspaceRoot: repo,
      updatedAt: new Date(Date.now() + 60000).toISOString()
    },
    finished
  ]);

  const resumeLast = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumeLast.status, 1);
  assert.match(resumeLast.stderr, /Codex thread thr_1 is still in use by running job task-busy/);

  const resumeFinished = run("node", [SCRIPT, "task", "--resume-job", finished.id, "follow up"], { cwd: repo, env });
  assert.equal(resumeFinished.status, 1);
  assert.match(resumeFinished.stderr, /still in use by running job task-busy/);

  const resumeRunning = run("node", [SCRIPT, "task", "--resume-job", "task-busy", "follow up"], { cwd: repo, env });
  assert.equal(resumeRunning.status, 1);
  assert.match(resumeRunning.stderr, /Job task-busy is still running\. Steer it with \/codex:steer task-busy/);
});

test("status, result, and cancel find a job by its full id in another workspace", async (t) => {
  const here = makeTempDir();
  const there = makeTempDir();
  const runningId = uniqueId("task-elsewhere");
  const finishedId = uniqueId("task-done-elsewhere");
  const sleeper = spawnSleeper(there);
  t.after(() => killQuietly(sleeper.pid));
  const stateDir = writeState(there, [
    {
      id: runningId,
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      workspaceRoot: there,
      pid: sleeper.pid,
      logFile: path.join(resolveStateDir(there), "jobs", `${runningId}.log`),
      updatedAt: "2026-10-21T03:00:00.000Z"
    },
    {
      id: finishedId,
      status: "completed",
      title: "Codex Task",
      jobClass: "task",
      workspaceRoot: there,
      updatedAt: "2026-10-21T02:00:00.000Z"
    }
  ]);
  fs.writeFileSync(path.join(stateDir, "jobs", `${runningId}.log`), "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${finishedId}.json`),
    JSON.stringify({ id: finishedId, result: { rawOutput: "Finished over there." } }),
    "utf8"
  );

  const status = run("node", [SCRIPT, "status", runningId, "--json"], { cwd: here });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.id, runningId);

  const result = run("node", [SCRIPT, "result", finishedId], { cwd: here });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finished over there\./);

  // A prefix never reaches into another workspace.
  const byPrefix = run("node", [SCRIPT, "cancel", runningId.slice(0, -3), "--json"], { cwd: here });
  assert.equal(byPrefix.status, 1);
  assert.ok(isAlive(sleeper.pid));

  const cancel = run("node", [SCRIPT, "cancel", runningId, "--json"], { cwd: here });
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => !isAlive(sleeper.pid));
  assert.equal(readState(there).jobs.find((job) => job.id === runningId).status, "cancelled");
});

test("status lists this session's running jobs from other workspaces", () => {
  const here = makeTempDir();
  const there = makeTempDir();
  const sessionId = uniqueId("sess");
  const mineId = uniqueId("task-mine-elsewhere");
  writeState(there, [
    {
      id: mineId,
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId,
      workspaceRoot: there,
      summary: "Runs in another repository",
      updatedAt: "2026-10-21T03:00:00.000Z"
    },
    {
      id: uniqueId("task-theirs-elsewhere"),
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId: uniqueId("sess-other"),
      workspaceRoot: there,
      updatedAt: "2026-10-21T03:01:00.000Z"
    }
  ]);
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: sessionId };

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: here, env });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(
    JSON.parse(status.stdout).running.map((job) => job.id),
    [mineId]
  );

  const rendered = run("node", [SCRIPT, "status"], { cwd: here, env });
  assert.match(rendered.stdout, new RegExp(`Workspace: ${there.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("session end stops this session's jobs in every workspace it used", async (t) => {
  const here = makeTempDir();
  const there = makeTempDir();
  const sessionId = uniqueId("sess");
  const theirsId = uniqueId("task-theirs-elsewhere");
  const sleeper = spawnSleeper(there);
  t.after(() => killQuietly(sleeper.pid));
  writeState(there, [
    {
      id: uniqueId("task-mine-elsewhere"),
      status: "running",
      title: "Codex Task",
      jobClass: "task",
      sessionId,
      workspaceRoot: there,
      pid: sleeper.pid,
      updatedAt: "2026-10-21T03:00:00.000Z"
    },
    {
      id: theirsId,
      status: "completed",
      title: "Codex Task",
      jobClass: "task",
      sessionId: uniqueId("sess-other"),
      workspaceRoot: there,
      updatedAt: "2026-10-21T03:01:00.000Z"
    }
  ]);

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: here,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: sessionId },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: here })
  });
  assert.equal(result.status, 0, result.stderr);
  await waitFor(() => !isAlive(sleeper.pid));
  assert.deepEqual(
    readState(there).jobs.map((job) => job.id),
    [theirsId]
  );
});

test("session end cleans resistant workers and brokers in six workspaces within the SessionEnd timeout", async (t) => {
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  const workers = [];
  const brokers = [];
  t.after(async () => {
    workers.forEach((worker) => killQuietly(worker.pid));
    await Promise.all(brokers.filter(Boolean).map(async (broker) => {
      await sendBrokerShutdown(broker.endpoint);
      teardownBrokerSession({ ...broker, killProcess: terminateProcessTree });
    }));
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    }
  });
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);
  const sessionId = uniqueId("sess-multi");
  const workspaces = Array.from({ length: 6 }, () => makeTempDir());
  for (const workspace of workspaces) {
    const worker = spawnSleeper(workspace, `
      import fs from "node:fs";
      process.on("SIGTERM", () => {});
      fs.writeFileSync(new URL("./ready", import.meta.url), "ready");
      setInterval(() => {}, 1000);
    `);
    workers.push(worker);
    writeState(workspace, [{
      id: uniqueId("task-resistant"), sessionId, workspaceRoot: workspace,
      status: "running", jobClass: "task", pid: worker.pid
    }]);
    brokers.push(await ensureBrokerSession(workspace, { env }));
  }
  await waitFor(() => workspaces.every((workspace) => fs.existsSync(path.join(workspace, "ready"))));
  assert.ok(brokers.every(Boolean));
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins/codex/hooks/hooks.json"), "utf8"));
  const timeout = hooks.hooks.SessionEnd[0].hooks[0].timeout * 1000;

  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: workspaces[0], env, timeout,
    input: JSON.stringify({ session_id: sessionId, cwd: workspaces[0] })
  });
  assert.equal(ended.status, 0, ended.error?.message ?? ended.stderr);
  await waitFor(() => workers.every((worker) => !isAlive(worker.pid)) && brokers.every((broker) => !isAlive(broker.pid)));
  for (const workspace of workspaces) {
    assert.deepEqual(readState(workspace).jobs, []);
    assert.equal(loadBrokerSession(workspace), null);
  }
});

test("session end cleans a configured workspace broker even when no jobs were started", async (t) => {
  const { repo, env } = setupRepo();
  const caller = makeTempDir();
  const configDir = makeTempDir();
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    pluginConfigs: { "codex@openai-codex": { options: { workspace_root: repo } } }
  }));
  const broker = await ensureBrokerSession(repo, { env });
  t.after(async () => {
    await sendBrokerShutdown(broker.endpoint);
    teardownBrokerSession({ ...broker, killProcess: terminateProcessTree });
  });

  const end = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: caller,
    env: { ...env, CLAUDE_CONFIG_DIR: configDir },
    input: JSON.stringify({ session_id: uniqueId("sess-configured"), cwd: caller })
  });
  assert.equal(end.status, 0, end.stderr);
  assert.equal(loadBrokerSession(repo), null);
  await waitFor(() => !isAlive(broker.pid));
});

test("task honors auto_review saved in Claude settings when the session never persisted it", () => {
  const configDir = makeTempDir();
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ pluginConfigs: { "codex@openai-codex": { options: { auto_review: true } } } }),
    "utf8"
  );
  const { repo, env, fakeStatePath } = setupRepo("review-ok", { CLAUDE_CONFIG_DIR: configDir });

  const task = run("node", [SCRIPT, "task", "--write", "fix the failing test"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastThreadStart, {
    serviceTier: null,
    config: { "features.fast_mode": false },
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write"
  });

  const setup = run("node", [SCRIPT, "setup"], { cwd: repo, env });
  assert.match(setup.stdout, /^- task approvals: auto-review \(plugin config\)$/m);

  // An explicit session value still wins over the saved settings.
  const disabled = run("node", [SCRIPT, "setup"], { cwd: repo, env: { ...env, CODEX_COMPANION_AUTO_REVIEW: "false" } });
  assert.match(disabled.stdout, /^- task approvals: never \(plugin config\)$/m);
});

async function waitForJob(repo, jobId, status = "completed") {
  return waitFor(
    () => {
      const job = readState(repo).jobs.find((candidate) => candidate.id === jobId);
      return job && job.status !== "queued" && job.status !== "running" ? job : null;
    },
    { timeoutMs: 20000 }
  ).then((job) => {
    assert.equal(job.status, status, job.errorMessage);
    return job;
  });
}

test("a task resumes the thread of a background job that just completed", async () => {
  const { repo, env, fakeStatePath } = setupRepo();
  const first = run("node", [SCRIPT, "task", "--background", "--json", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const firstJob = await waitForJob(repo, JSON.parse(first.stdout).jobId);

  // Each job's app server holds its thread's writer lock until it exits, which it does when the job ends.
  const resumed = run("node", [SCRIPT, "task", "--background", "--json", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedJob = await waitForJob(repo, JSON.parse(resumed.stdout).jobId);
  assert.equal(resumedJob.threadId, firstJob.threadId);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual([fakeState.lastTurnStart.threadId, fakeState.lastTurnStart.prompt], [firstJob.threadId, "follow up"]);
});

test("a task resumes a thread the idle shared broker still holds by stopping that broker first", async () => {
  const { repo, env, fakeStatePath } = setupRepo();
  // Like a task an older plugin version ran on the broker: the broker's app server keeps the thread loaded.
  const session = await ensureBrokerSession(repo, { env });
  const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
  let threadId;
  try {
    threadId = (await client.request("thread/start", { cwd: repo, ephemeral: false })).thread.id;
  } finally {
    await client.close();
  }

  const resumed = run("node", [SCRIPT, "task", "--resume-thread", threadId, "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, new RegExp(`Stopped the idle shared Codex runtime, which still had thread ${threadId} loaded`));
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, threadId);
  assert.equal(loadBrokerSession(repo), null);
  await waitFor(() => !isAlive(session.pid));
});

test("a task explains when a busy shared broker still holds the thread it should resume", async () => {
  const { repo, env } = setupRepo("interruptible-slow-task", { FAKE_CODEX_TURN_MS: "30000" });
  const session = await ensureBrokerSession(repo, { env });
  const owner = await CodexAppServerClient.connect(repo, { brokerEndpoint: session.endpoint });
  try {
    const held = (await owner.request("thread/start", { cwd: repo, ephemeral: false })).thread.id;
    const streaming = (await owner.request("thread/start", { cwd: repo, ephemeral: true })).thread.id;
    const { turn } = await owner.request("turn/start", {
      threadId: streaming,
      input: [{ type: "text", text: "review", text_elements: [] }]
    });

    const resumed = run("node", [SCRIPT, "task", "--resume-thread", held, "follow up"], { cwd: repo, env });
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /may still be loaded in this workspace's shared Codex runtime, which another job is using right now/);
    assert.ok(isAlive(session.pid), "a busy broker must not be stopped");

    await owner.request("turn/interrupt", { threadId: streaming, turnId: turn.id });
  } finally {
    await owner.close();
  }
});

test("a task explains when another Codex app server has the thread open", () => {
  const { repo, env, binDir } = setupRepo();
  assert.equal(run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env }).status, 0);
  // Another live process (standing in for the Codex app) holds the thread's writer lock.
  fs.writeFileSync(path.join(binDir, "thread-locks", "thr_1"), String(process.pid), "utf8");

  const resumed = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /Codex thread thr_1 is open in another Codex app server, such as the Codex app or a `codex resume` session/);
});
