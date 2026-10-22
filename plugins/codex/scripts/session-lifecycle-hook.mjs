#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  queryBrokerStatus,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "./lib/broker-lifecycle.mjs";
import { stopJobProcesses } from "./lib/job-runtime.mjs";
import { listWorkspaceStates, loadState, resolveStateFile, updateState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { AUTO_REVIEW_OPTION_ENV, AUTO_REVIEW_OVERRIDE_ENV } from "./lib/auto-review.mjs";
import { CODEX_HOME_OPTION_ENV, CODEX_HOME_OVERRIDE_ENV, expandHomePath } from "./lib/codex-home.mjs";
import { FAST_MODE_OPTION_ENV, FAST_MODE_OVERRIDE_ENV } from "./lib/fast-mode.mjs";
import { applyPluginOptionSettingsFallback } from "./lib/plugin-options.mjs";
import {
  resolveWorkspaceRoot,
  WORKSPACE_ROOT_OPTION_ENV,
  WORKSPACE_ROOT_OVERRIDE_ENV
} from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

// The hook has a few seconds in all, so give processes less time to exit than an interactive cancel does.
const SESSION_END_GRACE_MS = 1000;

async function cleanupSessionJobs(workspaceRoot, sessionId) {
  if (!workspaceRoot || !sessionId) {
    return;
  }

  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  const runningJobs = removedJobs.filter((job) => job.status === "queued" || job.status === "running");
  await Promise.all(
    runningJobs.map((job) =>
      // Ignore teardown failures during session shutdown.
      stopJobProcesses(job, { graceMs: SESSION_END_GRACE_MS }).catch(() => {})
    )
  );

  // Other jobs in the workspace may have updated the state while these were stopping.
  updateState(workspaceRoot, (latest) => {
    latest.jobs = latest.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

// Workspaces where this session ran jobs: the session's own, plus any it reached with --cwd.
function listSessionWorkspaces(cwd, sessionId) {
  const workspaceRoots = new Set([resolveWorkspaceRoot(cwd)]);
  // A configured directory may have been removed, but its saved state and processes still need cleanup.
  const configuredRoot = expandHomePath(process.env[WORKSPACE_ROOT_OPTION_ENV]) ?? expandHomePath(process.env[WORKSPACE_ROOT_OVERRIDE_ENV]);
  if (configuredRoot) {
    workspaceRoots.add(resolveWorkspaceRoot(configuredRoot));
  }
  if (sessionId) {
    for (const workspace of listWorkspaceStates()) {
      if (workspace.jobs.some((job) => job.sessionId === sessionId)) {
        workspaceRoots.add(workspace.workspaceRoot);
      }
    }
  }
  return [...workspaceRoots];
}

// Shuts down a workspace's shared broker unless another client (another Claude session) is using it right
// now; such a broker shuts itself down once it has been idle for a while.
async function shutdownWorkspaceBroker(workspaceRoot, brokerSession) {
  const endpoint = brokerSession?.endpoint ?? null;
  if (endpoint && (await waitForBrokerEndpoint(endpoint, 150))) {
    const status = await queryBrokerStatus(endpoint, 500);
    if (status.busy) {
      return;
    }
    await sendBrokerShutdown(endpoint, 1000);
  }

  teardownBrokerSession({
    endpoint,
    pidFile: brokerSession?.pidFile ?? null,
    logFile: brokerSession?.logFile ?? null,
    sessionDir: brokerSession?.sessionDir ?? null,
    pid: brokerSession?.pid ?? null,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(workspaceRoot);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  appendEnvVar(CODEX_HOME_OVERRIDE_ENV, expandHomePath(process.env[CODEX_HOME_OPTION_ENV]));
  appendEnvVar(WORKSPACE_ROOT_OVERRIDE_ENV, expandHomePath(process.env[WORKSPACE_ROOT_OPTION_ENV]));
  appendEnvVar(FAST_MODE_OVERRIDE_ENV, process.env[FAST_MODE_OPTION_ENV]);
  appendEnvVar(AUTO_REVIEW_OVERRIDE_ENV, process.env[AUTO_REVIEW_OPTION_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const cwdWorkspaceRoot = resolveWorkspaceRoot(cwd);
  const workspaceRoots = listSessionWorkspaces(cwd, sessionId);

  // Stop this session's jobs first: a job streaming through a broker would otherwise keep it busy.
  await Promise.all(workspaceRoots.map((workspaceRoot) => cleanupSessionJobs(workspaceRoot, sessionId)));

  await Promise.all(workspaceRoots.map(async (workspaceRoot) => {
    const brokerSession =
      loadBrokerSession(workspaceRoot) ??
      (workspaceRoot === cwdWorkspaceRoot && process.env[BROKER_ENDPOINT_ENV]
        ? {
            endpoint: process.env[BROKER_ENDPOINT_ENV],
            pidFile: process.env[PID_FILE_ENV] ?? null,
            logFile: process.env[LOG_FILE_ENV] ?? null
          }
        : null);
    await shutdownWorkspaceBroker(workspaceRoot, brokerSession);
  }));
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    applyPluginOptionSettingsFallback();
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
