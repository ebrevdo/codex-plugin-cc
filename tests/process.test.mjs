import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { findJobProcesses, terminateProcesses, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree signals the pid itself when it does not lead a process group", () => {
  const signals = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      signals.push([pid, signal]);
      if (pid < 0) {
        throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
      }
    }
  });

  assert.deepEqual(signals, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`process ${pid} is still running`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function readPidWhenWritten(file) {
  return new Promise((resolve) => {
    const poll = () => {
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (text) {
        resolve(Number.parseInt(text, 10));
      } else {
        setTimeout(poll, 25);
      }
    };
    poll();
  });
}

test("findJobProcesses follows a job into other process groups and finds processes that carry its marker", { skip: process.platform === "win32" }, async (t) => {
  const dir = makeTempDir();
  const sleeper = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
  // A parent with a child in its own process group, like a command Codex runs.
  const parent = spawn(
    process.execPath,
    ["-e", `require('child_process').spawn(process.execPath, ['-e', process.argv[2], process.argv[1]], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000);`, path.join(dir, "child"), sleeper],
    { stdio: "ignore" }
  );
  // An unrelated process that carries the marker in its environment.
  const marked = spawn(process.execPath, ["-e", sleeper, path.join(dir, "marked")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CODEX_COMPANION_JOB_ID: "job-under-test" }
  });
  const childPid = await readPidWhenWritten(path.join(dir, "child"));
  await readPidWhenWritten(path.join(dir, "marked"));
  t.after(() => {
    for (const pid of [parent.pid, childPid, marked.pid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  const byTree = findJobProcesses({ rootPids: [parent.pid, process.pid] });
  assert.ok(byTree.includes(parent.pid));
  assert.ok(byTree.includes(childPid));
  assert.ok(!byTree.includes(process.pid), "never includes the caller");

  if (process.platform === "linux") {
    const byMarker = findJobProcesses({ marker: "CODEX_COMPANION_JOB_ID=job-under-test" });
    assert.deepEqual(byMarker, [marked.pid]);
    assert.deepEqual(findJobProcesses({ marker: "CODEX_COMPANION_JOB_ID=job-under" }), []);
  }

  const outcome = await terminateProcesses(byTree, { graceMs: 2000 });
  assert.equal(outcome.signalled, 2);
  await waitForExit(childPid);
});

test("terminateProcesses escalates to SIGKILL for processes that ignore SIGTERM", { skip: process.platform === "win32" }, async () => {
  const dir = makeTempDir();
  const stubborn = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", path.join(dir, "pid")],
    { detached: true, stdio: "ignore" }
  );
  await readPidWhenWritten(path.join(dir, "pid"));

  const outcome = await terminateProcesses([stubborn.pid], { graceMs: 300 });
  assert.equal(outcome.killed, 1);
  await waitForExit(stubborn.pid);
});
