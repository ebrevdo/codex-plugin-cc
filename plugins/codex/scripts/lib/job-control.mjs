import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { getConfig, listJobs, listWorkspaceStates, readJobFile, resolveJobFile, resolveStateDir } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

// Returns the job whose id is `reference`, else the only job whose id starts with it, else null.
function findJobReference(jobs, reference) {
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = jobs.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return prefixMatches[0] ?? null;
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const match = findJobReference(filtered, reference);
  if (match) {
    return match;
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

// Workspaces other than `workspaceRoot` that have plugin state, each with its jobs newest first.
function listOtherWorkspaceJobs(workspaceRoot) {
  const stateDir = resolveStateDir(workspaceRoot);
  return listWorkspaceStates()
    .filter((workspace) => workspace.stateDir !== stateDir)
    .map((workspace) => ({ workspaceRoot: workspace.workspaceRoot, jobs: sortJobsNewestFirst(workspace.jobs) }));
}

// Looks a full job id up in every other workspace with plugin state. Job ids are unique, so a job started
// with --cwd in another repository can still be inspected, steered, cancelled, or resumed by id from here.
// Prefixes only match jobs in the current workspace, so a short reference never reaches another repository.
function findJobInOtherWorkspaces(workspaceRoot, reference, predicate = () => true) {
  for (const workspace of listOtherWorkspaceJobs(workspaceRoot)) {
    const job = workspace.jobs.find((candidate) => candidate.id === reference && predicate(candidate));
    if (job) {
      return { workspaceRoot: workspace.workspaceRoot, job };
    }
  }
  return null;
}

// Resolves a job reference in this workspace first and then in any other workspace.
export function resolveJobReference(cwd, reference, predicate = () => true) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const local = findJobReference(sortJobsNewestFirst(listJobs(workspaceRoot)).filter(predicate), reference);
  if (local) {
    return { workspaceRoot, job: local };
  }
  const elsewhere = findJobInOtherWorkspaces(workspaceRoot, reference, predicate);
  if (elsewhere) {
    return elsewhere;
  }
  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  // This session's jobs that run in another workspace (for example a task started with --cwd elsewhere).
  const elsewhere = getCurrentSessionId(options)
    ? listOtherWorkspaceJobs(workspaceRoot).flatMap((workspace) =>
        filterJobsForCurrentSession(workspace.jobs, options).filter((job) => isActiveStatus(job.status))
      )
    : [];

  const running = [...jobs.filter((job) => isActiveStatus(job.status)), ...elsewhere].map((job) =>
    enrichJob(job, { maxProgressLines })
  );

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const { workspaceRoot, job } = resolveJobReference(cwd, reference);
  return {
    workspaceRoot,
    job: enrichJob(job, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const isFinished = (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled";
  const selected = reference ? findJobReference(jobs.filter(isFinished), reference) : matchJobReference(jobs, reference, isFinished);

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = reference
    ? findJobReference(jobs.filter((job) => isActiveStatus(job.status)), reference)
    : matchJobReference(jobs, reference, (job) => isActiveStatus(job.status));
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    const elsewhere = findJobInOtherWorkspaces(workspaceRoot, reference);
    if (elsewhere && isFinished(elsewhere.job)) {
      return elsewhere;
    }
    if (elsewhere) {
      throw new Error(`Job ${elsewhere.job.id} is still ${elsewhere.job.status}. Check /codex:status and try again once it finishes.`);
    }
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

function listActiveJobs(workspaceRoot) {
  return sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.status === "queued" || job.status === "running");
}

// Like resolveActiveJob with a reference, but returns null instead of throwing when nothing matches.
export function findActiveJob(cwd, reference) {
  try {
    return resolveJobReference(cwd, reference, (job) => isActiveStatus(job.status));
  } catch {
    return null;
  }
}

export function resolveActiveJob(cwd, reference, options = {}) {
  const { command } = options;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const activeJobs = listActiveJobs(workspaceRoot);

  if (reference) {
    const selected = findJobReference(activeJobs, reference);
    if (selected) {
      return { workspaceRoot, job: selected };
    }
    const elsewhere = findJobInOtherWorkspaces(workspaceRoot, reference, (job) => isActiveStatus(job.status));
    if (elsewhere) {
      return elsewhere;
    }
    throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error(`Multiple Codex jobs are active. Pass a job id to /codex:${command}.`);
  }

  if (getCurrentSessionId(options)) {
    throw new Error(`No active Codex jobs to ${command} for this session.`);
  }

  throw new Error(`No active Codex jobs to ${command}.`);
}
