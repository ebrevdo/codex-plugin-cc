import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";
import { JOB_ID_ENV } from "./tracked-jobs.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
// A broker with no connected clients for this long shuts itself down. Zero or less keeps it running.
export const BROKER_IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
export const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const BROKER_BUSY_RPC_CODE = -32001;
const BROKER_STATE_FILE = "broker.json";
// The code a running broker executes. A broker keeps running the code it started with, so ensureBrokerSession
// compares this against the broker's own build id to replace brokers left over from older plugin code.
const BROKER_SOURCE_FILES = [
  "../app-server-broker.mjs",
  "./app-server.mjs",
  "./args.mjs",
  "./broker-endpoint.mjs",
  "./broker-lifecycle.mjs"
];

export function computeBrokerBuildId() {
  const hash = createHash("sha256");
  for (const file of BROKER_SOURCE_FILES) {
    hash.update(fs.readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest("hex").slice(0, 16);
}

export function resolveBrokerIdleTimeoutMs(env = process.env) {
  const raw = env[BROKER_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw === "") {
    return DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  }
  return value > 0 ? value : null;
}

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Sends one request to a broker and resolves with its first reply, or null when there is none in time.
function requestBroker(endpoint, method, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let buffer = "";
    const finish = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      try {
        finish(JSON.parse(buffer.slice(0, newlineIndex)));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export async function sendBrokerShutdown(endpoint, timeoutMs = 2000) {
  await requestBroker(endpoint, "broker/shutdown", timeoutMs);
}

// Asks a running broker which build it runs and whether another client is using it. Brokers from older
// plugin code do not know broker/status: an idle one forwards it to Codex, which rejects it, and a busy one
// answers that it is busy. When the broker does not answer at all, report it busy so nobody replaces it.
export async function queryBrokerStatus(endpoint, timeoutMs = 1000) {
  const reply = await requestBroker(endpoint, "broker/status", timeoutMs);
  if (reply?.result) {
    return { buildId: reply.result.buildId ?? null, busy: Boolean(reply.result.busy), pid: reply.result.pid ?? null };
  }
  return { buildId: null, busy: !reply || reply.error?.code === BROKER_BUSY_RPC_CODE, pid: null };
}

// Codex lets one app server at a time load a thread: it holds the thread's writer lock for as long as the
// thread stays loaded, and unsubscribing does not unload it. A shared broker keeps every thread it ran loaded
// (tasks from older plugin versions ran there), so the only way to free such a thread for a job's own app
// server is to stop the broker. Do that when the broker holds the thread and nobody is using it; the next
// command that needs a broker starts a fresh one. Returns "released", "busy" when a broker that may hold the
// thread is in use, or null when the workspace's broker does not hold it.
export async function releaseThreadFromBroker(cwd, threadId) {
  const session = loadBrokerSession(cwd);
  if (!session?.endpoint || !(await isBrokerEndpointReady(session.endpoint))) {
    return null;
  }

  const loaded = await requestBroker(session.endpoint, "thread/loaded/list", 2000);
  if (!loaded || loaded.error?.code === BROKER_BUSY_RPC_CODE) {
    return "busy";
  }
  if (!Array.isArray(loaded.result?.data) || !loaded.result.data.includes(threadId)) {
    return null;
  }
  if ((await queryBrokerStatus(session.endpoint)).busy) {
    return "busy";
  }

  await sendBrokerShutdown(session.endpoint);
  teardownBrokerSession({ ...session, killProcess: null });
  clearBrokerSession(cwd);
  return "released";
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  // The broker outlives the command that starts it and serves every job in the workspace, so it must not
  // carry a job's process marker, or cancelling that job would stop the shared broker too.
  const { [JOB_ID_ENV]: _jobId, ...brokerEnv } = env;
  const child = spawn(
    process.execPath,
    [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile, "--log-file", logFile],
    {
      cwd,
      env: brokerEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    }
  );
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    const status = await queryBrokerStatus(existing.endpoint);
    if (status.buildId === computeBrokerBuildId() || status.busy) {
      return existing;
    }
    // The broker runs code from an older version of the plugin and nobody is using it: replace it.
    await sendBrokerShutdown(existing.endpoint);
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
