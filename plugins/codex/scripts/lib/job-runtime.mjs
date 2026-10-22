import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { CodexAppServerClient, TURN_CONTROL_METHODS } from "./app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { createBrokerSessionDir } from "./broker-lifecycle.mjs";
import { findJobProcesses, readProcessCommand, terminateProcesses, terminateProcessTree } from "./process.mjs";
import { JOB_ID_ENV, jobProcessMarker } from "./tracked-jobs.mjs";

const CONTROL_DRAIN_TIMEOUT_MS = 2000;

function send(socket, message) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

async function handleControlMessage(socket, message, client) {
  if (message.id === undefined) {
    return;
  }
  if (message.method === "initialize") {
    send(socket, { id: message.id, result: { userAgent: "codex-companion-job-runtime" } });
    return;
  }
  if (!TURN_CONTROL_METHODS.has(message.method)) {
    send(socket, { id: message.id, error: { code: -32601, message: `${message.method} is not available on a job runtime.` } });
    return;
  }

  try {
    const result = await client.request(message.method, message.params ?? {});
    send(socket, { id: message.id, result });
  } catch (error) {
    send(socket, { id: message.id, error: { code: error.rpcCode ?? -32000, message: error.message } });
  }
}

// Accepts turn/interrupt and turn/steer from other companion commands and forwards them to the job's
// app server, alongside the turn the job itself is streaming.
function serveTurnControl(endpoint, client) {
  const sockets = new Set();
  const inFlight = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, { id: null, error: { code: -32700, message: `Invalid JSON: ${error.message}` } });
          continue;
        }
        const handled = handleControlMessage(socket, message, client);
        inFlight.add(handled);
        void handled.finally(() => inFlight.delete(handled));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parseBrokerEndpoint(endpoint).path, () => {
      server.off("error", reject);
      resolve({
        async close() {
          server.close();
          // An interrupt ends the turn before Codex answers it, so let replies in flight reach their callers.
          await Promise.race([
            Promise.allSettled([...inFlight]),
            new Promise((done) => setTimeout(done, CONTROL_DRAIN_TIMEOUT_MS).unref?.())
          ]);
          for (const socket of sockets) {
            socket.end();
            setTimeout(() => socket.destroy(), 500).unref?.();
          }
        }
      });
    });
  });
}

// Runs `fn` against a Codex app server that serves this one job. `onReady` receives the control endpoint
// that steer and cancel use to reach the running turn, and the app server's pid. Because no other job
// shares the app server, cancel can stop everything it started without touching other jobs' work.
export async function withJobRuntime(cwd, options, fn) {
  const sessionDir = createBrokerSessionDir("cxj-");
  const endpoint = createBrokerEndpoint(sessionDir);
  let client = null;
  let control = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      env: { ...(options.env ?? process.env), [JOB_ID_ENV]: options.jobId }
    });
    control = await serveTurnControl(endpoint, client);
    await options.onReady?.({ endpoint, appServerPid: client.pid ?? null });
    return await fn(client);
  } finally {
    await control?.close().catch(() => {});
    await client?.close().catch(() => {});
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

// Stops everything a job started: its companion process, the job's app server, every command Codex ran for
// it (each in its own process group), and anything those commands left running in the background. Processes
// are found by the job's environment marker (Linux) and by walking down from the job's companion process;
// the walk only starts from a pid that still runs the companion, so a stale record cannot hit another program.
export async function stopJobProcesses(job, options = {}) {
  const jobPid = Number.isFinite(job.pid) ? job.pid : null;
  const ownsJobPid = jobPid !== null && /codex-companion/.test(readProcessCommand(jobPid) ?? "");
  const find = () => findJobProcesses({ marker: jobProcessMarker(job.id), rootPids: ownsJobPid ? [jobPid] : [] });

  // Find the tree before signalling anything: once the job's processes exit, their children are reparented
  // and can no longer be reached by walking down from the job.
  const pids = find();
  if (ownsJobPid) {
    try {
      terminateProcessTree(jobPid);
    } catch {
      // The pid-based kill is best effort; the processes found above are signalled either way.
    }
  }
  const outcome = await terminateProcesses(pids, { graceMs: options.graceMs, rescan: find });
  removeJobRuntimeFiles(job.controlEndpoint);
  return outcome;
}

// A stopped job's companion never gets to remove its control socket; remove it and its empty directory.
function removeJobRuntimeFiles(endpoint) {
  if (!endpoint) {
    return;
  }
  try {
    const target = parseBrokerEndpoint(endpoint);
    if (target.kind === "unix") {
      fs.rmSync(target.path, { force: true });
      fs.rmdirSync(path.dirname(target.path));
    }
  } catch {
    // Already removed, or the directory holds something else.
  }
}
