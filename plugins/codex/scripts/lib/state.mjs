import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_WAIT_MS = 5000;
const STATE_LOCK_STALE_MS = 10000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

// Replaces the file in one step, so a concurrent reader sees the old or the new contents, never a torn write.
function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch {
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(filePath, contents, "utf8");
  }
}

function isLockStale(lockPath) {
  try {
    const holder = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
    if (Number.isFinite(holder) && holder > 0) {
      try {
        process.kill(holder, 0);
      } catch (error) {
        if (error?.code === "ESRCH") {
          return true;
        }
      }
    }
    return Date.now() - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// Serializes read-modify-write updates of one workspace's state: several job processes and companion
// commands update it at once, and an unserialized update can drop another one (such as a job's completion).
// After a few seconds of waiting, proceed without the lock rather than hang the command.
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  let locked = false;
  while (!locked) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      locked = true;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() > deadline) {
        break;
      }
      if (isLockStale(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      Atomics.wait(sleepCell, 0, 0, 5);
    }
  }

  try {
    return fn();
  } finally {
    if (locked) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

function resolveStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
}

function stateDirForWorkspaceRoot(workspaceRoot) {
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateDir(cwd) {
  return stateDirForWorkspaceRoot(resolveWorkspaceRoot(cwd));
}

// Every workspace with plugin state, as { workspaceRoot, stateDir, jobs }. Jobs are stored per workspace,
// so a job started with --cwd in another repository is only visible through this listing.
export function listWorkspaceStates() {
  const stateRoot = resolveStateRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const stateDir = path.join(stateRoot, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE_NAME), "utf8"));
    } catch {
      continue;
    }
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    const workspaceRoot = jobs.map((job) => job?.workspaceRoot).find((value) => typeof value === "string" && value);
    if (workspaceRoot && stateDirForWorkspaceRoot(workspaceRoot) === stateDir) {
      workspaces.push({ workspaceRoot, stateDir, jobs });
    }
  }
  return workspaces;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
