#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    forkAppServerThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    steerAppServerTurn
  } from "./lib/codex.mjs";
import { describeTaskApprovals, resolveTaskApprovals } from "./lib/auto-review.mjs";
import { applyConfiguredCodexHome, describeCodexHome } from "./lib/codex-home.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { describeFastMode } from "./lib/fast-mode.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { stopJobProcesses } from "./lib/job-runtime.mjs";
import { applyPluginOptionSettingsFallback } from "./lib/plugin-options.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  findActiveJob,
  readStoredJob,
  resolveActiveJob,
  resolveJobReference,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  patchJob,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveConfiguredWorkspaceRoot, resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderSteerReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--resume-job <job-id>|--resume-thread <thread-id>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs fork [session-id] [--job <job-id>] [--model <model|spark>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "  node scripts/codex-companion.mjs steer [job-id] [--prompt-file <path>] [--json] [instructions]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max, ultra.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return resolveConfiguredWorkspaceRoot() ?? (options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd());
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    codexHome: describeCodexHome(),
    workspaceRoot: resolveConfiguredWorkspaceRoot() ?? workspaceRoot,
    fastMode: describeFastMode(),
    taskApprovals: describeTaskApprovals(),
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

// The queued or running job that is working on a Codex thread, if any. Two runs on one thread would
// interleave their turns, so a thread can be resumed only once nothing else is running on it.
function findJobUsingThread(jobs, threadId, excludeJobId = null) {
  return (
    jobs.find(
      (job) =>
        job.id !== excludeJobId &&
        isActiveJobStatus(job.status) &&
        (job.threadId === threadId || job.request?.resumeThreadId === threadId)
    ) ?? null
  );
}

function assertThreadIdle(jobs, threadId, excludeJobId = null) {
  const busy = findJobUsingThread(jobs, threadId, excludeJobId);
  if (busy) {
    throw new Error(
      `Codex thread ${threadId} is still in use by ${busy.status} job ${busy.id}. Steer it with /codex:steer ${busy.id}, wait for it to finish, or stop it with /codex:cancel ${busy.id}.`
    );
  }
}

// Picks the Codex thread a task continues: a specific job's thread (--resume-job), a thread id
// (--resume-thread), or the newest finished task from this Claude session (--resume-last). Jobs running on
// other threads never block a resume. Returns null when --resume-last finds no tracked task and the caller
// should fall back to Codex's own thread list.
function resolveTaskResumeTarget(workspaceRoot, { resumeLast = false, resumeJob = null, resumeThread = null, excludeJobId = null, fallbackWorkspaceRoot = null }) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== excludeJobId);

  if (resumeJob) {
    const { workspaceRoot: jobWorkspaceRoot, job } = resolveJobReference(workspaceRoot, resumeJob, (candidate) => candidate.jobClass === "task");
    if (isActiveJobStatus(job.status)) {
      throw new Error(`Job ${job.id} is still ${job.status}. Steer it with /codex:steer ${job.id}, or resume it once it finishes.`);
    }
    if (!job.threadId) {
      throw new Error(`Job ${job.id} never started a Codex thread, so there is nothing to resume.`);
    }
    assertThreadIdle([...jobs, ...listJobs(jobWorkspaceRoot)], job.threadId, excludeJobId);
    return { threadId: job.threadId, jobId: job.id, workspaceRoot: jobWorkspaceRoot };
  }

  if (resumeThread) {
    assertThreadIdle(jobs, resumeThread, excludeJobId);
    return { threadId: resumeThread, jobId: jobs.find((job) => job.threadId === resumeThread)?.id ?? null, workspaceRoot };
  }

  if (!resumeLast) {
    return null;
  }
  const resumeWorkspaces = [...new Set([workspaceRoot, fallbackWorkspaceRoot].filter(Boolean))];
  for (const resumeWorkspace of resumeWorkspaces) {
    const candidates = resumeWorkspace === workspaceRoot ? jobs : sortJobsNewestFirst(listJobs(resumeWorkspace)).filter((job) => job.id !== excludeJobId);
    const trackedTask = findLatestResumableTaskJob(filterJobsForCurrentClaudeSession(candidates));
    if (trackedTask) {
      assertThreadIdle([...jobs, ...candidates], trackedTask.threadId, excludeJobId);
      return { threadId: trackedTask.threadId, jobId: trackedTask.id, workspaceRoot: resumeWorkspace };
    }
  }
  if (getCurrentClaudeSessionId()) {
    throw new Error("No previous Codex task thread was found for this repository.");
  }
  return null;
}

async function resolveResumeThreadId(workspaceRoot, request) {
  if (request.resumeThreadId) {
    return request.resumeThreadId;
  }
  if (!request.resumeLast) {
    return null;
  }

  // Requests queued before the thread was chosen up front, or that found no tracked task, resolve here.
  const target = resolveTaskResumeTarget(workspaceRoot, { resumeLast: true, excludeJobId: request.jobId });
  const latestThread = target ? { id: target.threadId } : await findLatestTaskThread(workspaceRoot);
  if (!latestThread) {
    throw new Error("No previous Codex task thread was found for this repository.");
  }
  return latestThread.id;
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: Boolean(request.resumeLast || request.resumeThreadId)
  });

  const resumeThreadId = await resolveResumeThreadId(workspaceRoot, request);

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const jobId = request.jobId ?? null;
  let result;
  try {
    result = await runAppServerTurn(request.cwd, {
      resumeThreadId,
      prompt: request.prompt,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model: request.model,
      effort: request.effort,
      sandbox: request.write ? "workspace-write" : "read-only",
      ...resolveTaskApprovals(),
      onProgress: request.onProgress,
      persistThread: true,
      threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT),
      // The job's own app server; steer and cancel find it through the endpoint recorded in the job.
      jobRuntime: jobId
        ? {
            jobId,
            onReady: ({ endpoint, appServerPid }) =>
              patchJob(workspaceRoot, jobId, { transport: "job", controlEndpoint: endpoint, appServerPid })
          }
        : null
    });
  } finally {
    if (jobId) {
      patchJob(workspaceRoot, jobId, { controlEndpoint: null, appServerPid: null });
    }
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, resumeThreadId = null, resumeJobId = null, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    resumeThreadId,
    resumeJobId,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

function renderForkResult(payload) {
  const lines = [
    `Forked Codex session ${payload.sourceThreadId}.`,
    `Job: ${payload.jobId}`,
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`,
    `Continue with /codex:rescue --resume-job ${payload.jobId}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "resume-job", "resume-thread"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const resumeJob = options["resume-job"] ? String(options["resume-job"]).trim() : null;
  const resumeThread = options["resume-thread"] ? String(options["resume-thread"]).trim() : null;
  const fresh = Boolean(options.fresh);
  if ([resumeLast, Boolean(resumeJob), Boolean(resumeThread), fresh].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --resume/--resume-last, --resume-job, --resume-thread, or --fresh.");
  }
  const write = Boolean(options.write);

  // Choose the thread now, so a queued resume holds on to the thread that was newest when it was asked for
  // and later resumes can see that the thread is taken.
  const configuredRoot = resolveConfiguredWorkspaceRoot();
  const fallbackWorkspaceRoot = resumeLast && configuredRoot
    ? resolveWorkspaceRoot(options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd())
    : null;
  const resumeTarget = resolveTaskResumeTarget(workspaceRoot, { resumeLast, resumeJob, resumeThread, fallbackWorkspaceRoot });
  const taskCwd = configuredRoot ?? resumeTarget?.workspaceRoot ?? workspaceRoot;
  const taskWorkspaceRoot = resolveWorkspaceRoot(taskCwd);
  const resuming = resumeLast || Boolean(resumeTarget);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resuming
  });
  const requestOptions = {
    cwd: taskCwd,
    model,
    effort,
    prompt,
    write,
    resumeLast: resumeLast && !resumeTarget,
    resumeThreadId: resumeTarget?.threadId ?? null,
    resumeJobId: resumeTarget?.jobId ?? null
  };

  if (options.background) {
    ensureCodexAvailable(taskCwd);
    requireTaskRequest(prompt, resuming);

    const job = buildTaskJob(taskWorkspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({ ...requestOptions, jobId: job.id });
    const { payload } = enqueueBackgroundTask(taskCwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(taskWorkspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...requestOptions,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleFork(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job", "model"],
    booleanOptions: ["json"],
    aliasMap: { m: "model" }
  });
  if (positionals.length > 1 || (positionals.length && options.job)) {
    throw new Error("Choose a Codex session ID or --job <job-id>, or omit both to fork the latest task thread.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const configuredRoot = resolveConfiguredWorkspaceRoot();
  let sourceThreadId = positionals[0] ?? null;
  let sourceWorkspaceRoot = workspaceRoot;

  if (options.job) {
    const source = resolveJobReference(workspaceRoot, options.job, (job) => job.jobClass === "task");
    if (!source.job.threadId) {
      throw new Error(`Job ${source.job.id} never started a Codex thread, so there is nothing to fork.`);
    }
    sourceThreadId = source.job.threadId;
    sourceWorkspaceRoot = source.workspaceRoot;
  } else if (!sourceThreadId) {
    const fallbackWorkspaceRoot = resolveWorkspaceRoot(options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd());
    for (const root of new Set([workspaceRoot, fallbackWorkspaceRoot])) {
      const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(root)));
      const source = jobs.find((job) => job.jobClass === "task" && job.threadId);
      if (source) {
        sourceThreadId = source.threadId;
        break;
      }
    }
    if (!sourceThreadId && !getCurrentClaudeSessionId()) {
      sourceThreadId = (await findLatestTaskThread(cwd))?.id ?? null;
    }
    if (!sourceThreadId) {
      throw new Error("No previous Codex task thread was found for this repository. Pass a Codex session ID or --job <job-id>.");
    }
  }

  const forkCwd = configuredRoot ?? (options.job ? sourceWorkspaceRoot : cwd);
  ensureCodexAvailable(forkCwd);
  const job = createCompanionJob({
    prefix: "task",
    kind: "fork",
    title: "Codex Fork",
    workspaceRoot: resolveWorkspaceRoot(forkCwd),
    jobClass: "task",
    summary: `Fork of ${sourceThreadId}`
  });
  await runForegroundCommand(
    job,
    async (progress) => {
      const result = await forkAppServerThread(forkCwd, {
        threadId: sourceThreadId,
        model: normalizeRequestedModel(options.model),
        ...resolveTaskApprovals(),
        onProgress: progress
      });
      const payload = {
        jobId: job.id,
        sourceThreadId,
        threadId: result.threadId,
        resumeCommand: `codex resume ${result.threadId}`
      };
      return {
        exitStatus: 0,
        threadId: result.threadId,
        payload,
        rendered: renderForkResult(payload),
        summary: `Fork of ${sourceThreadId}`
      };
    },
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  // A queued job keeps the workspace chosen at launch, even if plugin settings change before it starts.
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

// The job's turn, and the control endpoint of the job's own runtime when it has one. Jobs without an
// endpoint (reviews, or tasks started by older plugin versions) are reached through the workspace broker.
function resolveJobTurn(workspaceRoot, job) {
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  return {
    existing,
    threadId: existing.threadId ?? job.threadId ?? null,
    turnId: existing.turnId ?? job.turnId ?? null,
    endpoint: existing.controlEndpoint ?? job.controlEndpoint ?? null
  };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveActiveJob(cwd, reference, { env: process.env, command: "cancel" });
  const { existing, threadId, turnId, endpoint } = resolveJobTurn(workspaceRoot, job);

  // Interrupt first so Codex records the turn as interrupted, then stop every process the job started:
  // interrupting a turn does not stop commands it left running in the background.
  const interrupt = await interruptAppServerTurn(workspaceRoot, { threadId, turnId, endpoint });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  const stopped = await stopJobProcesses({ ...job, pid: job.pid ?? existing.pid ?? null, controlEndpoint: endpoint });
  if (stopped.signalled > 0) {
    appendLogLine(
      job.logFile,
      `Stopped ${stopped.signalled} process(es) started by the job${stopped.killed > 0 ? ` (${stopped.killed} needed SIGKILL)` : ""}.`
    );
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    controlEndpoint: null,
    appServerPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    controlEndpoint: null,
    appServerPid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    processesStopped: stopped.signalled
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function handleSteer(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "prompt-file"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  // A leading token names the job only when it matches an active job id, so instructions can start with any word.
  const [first, ...rest] = positionals;
  const named = first?.includes("-") ? findActiveJob(cwd, first) : null;
  const prompt = (readTaskPrompt(cwd, options, named ? rest : positionals) ?? "").trim();
  if (!prompt) {
    throw new Error("Provide steering instructions, a prompt file, or piped stdin.");
  }

  const { workspaceRoot, job } = named ?? resolveActiveJob(cwd, "", { env: process.env, command: "steer" });
  const { threadId, turnId, endpoint } = resolveJobTurn(workspaceRoot, job);

  const steer = await steerAppServerTurn(workspaceRoot, { threadId, turnId, prompt, endpoint });
  if (steer.attempted) {
    appendLogLine(
      job.logFile,
      steer.steered
        ? `Steered turn ${turnId}: ${shorten(prompt)}`
        : `Codex turn steer failed${steer.detail ? `: ${steer.detail}` : "."}`
    );
  }

  const payload = {
    jobId: job.id,
    title: job.title,
    threadId,
    turnId,
    steerAttempted: steer.attempted,
    steered: steer.steered,
    detail: steer.detail
  };

  outputCommandResult(payload, renderSteerReport(job, steer, { ownRuntime: Boolean(endpoint) }), options.json);
  if (!steer.steered) {
    process.exitCode = 1;
  }
}

async function main() {
  applyPluginOptionSettingsFallback();
  applyConfiguredCodexHome();
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "fork":
      await handleFork(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "steer":
      await handleSteer(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
