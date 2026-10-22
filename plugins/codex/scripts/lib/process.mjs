import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch {
    // A foreground job runs inside its caller's process group, so its pid may not lead a group of its own.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw innerError;
    }
  }
}

function readProcFile(procRoot, pid, name) {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), name), "utf8");
  } catch {
    return null;
  }
}

function parseProcStat(stat) {
  // The command name sits in parentheses and may itself contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], ppid: Number(fields[1]) };
}

// Lists live processes as { pid, ppid }, skipping zombies. Returns [] where neither /proc nor ps is available.
export function listProcesses(options = {}) {
  const platform = options.platform ?? process.platform;
  const procRoot = options.procRoot ?? "/proc";
  if (platform === "win32") {
    return [];
  }

  if (platform === "linux" && fs.existsSync(procRoot)) {
    const processes = [];
    for (const entry of fs.readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      const stat = readProcFile(procRoot, entry, "stat");
      if (!stat) {
        continue;
      }
      const { state, ppid } = parseProcStat(stat);
      if (state !== "Z" && state !== "X") {
        processes.push({ pid: Number(entry), ppid });
      }
    }
    return processes;
  }

  const result = runCommand("ps", ["-A", "-o", "pid=,ppid=,stat="]);
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, ppid, state]) => /^\d+$/.test(pid ?? "") && /^\d+$/.test(ppid ?? "") && !String(state).startsWith("Z"))
    .map(([pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid) }));
}

// Returns a process's command line, or null when it is gone or unreadable.
export function readProcessCommand(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const cmdline = readProcFile(options.procRoot ?? "/proc", pid, "cmdline");
    return cmdline ? cmdline.split("\0").filter(Boolean).join(" ") : null;
  }
  if (platform === "win32") {
    return null;
  }
  const result = runCommand("ps", ["-o", "command=", "-p", String(pid)]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

// Finds every live process that belongs to a job: the given roots, processes whose environment holds the
// `marker` entry (NAME=value; Linux only), and all of their descendants, whichever process group or session
// they moved to. This process and its ancestors are never included.
export function findJobProcesses({ marker = null, rootPids = [], platform = process.platform, procRoot = "/proc" } = {}) {
  const processes = listProcesses({ platform, procRoot });
  const parents = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const children = new Map();
  for (const { pid, ppid } of processes) {
    if (!children.has(ppid)) {
      children.set(ppid, []);
    }
    children.get(ppid).push(pid);
  }

  const excluded = new Set([0, 1]);
  for (let cursor = process.pid; cursor && !excluded.has(cursor); cursor = parents.get(cursor)) {
    excluded.add(cursor);
  }

  const roots = rootPids.filter((pid) => Number.isFinite(pid) && parents.has(pid));
  if (marker && platform === "linux") {
    for (const { pid } of processes) {
      const environ = readProcFile(procRoot, pid, "environ");
      if (environ && environ.split("\0").includes(marker)) {
        roots.push(pid);
      }
    }
  }

  const found = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (found.has(pid) || excluded.has(pid)) {
      continue;
    }
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...found];
}

function isProcessAlive(pid, platform) {
  if (platform === "linux") {
    const stat = readProcFile("/proc", pid, "stat");
    if (stat !== null) {
      const { state } = parseProcStat(stat);
      return state !== "Z" && state !== "X";
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcess(pid, signal, killImpl) {
  try {
    killImpl(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Sends SIGTERM to each process, waits up to `graceMs` for them to exit, then SIGKILLs whatever is left plus
// anything `rescan()` finds by then (such as children forked during the grace period).
export async function terminateProcesses(pids, options = {}) {
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const graceMs = Math.max(0, options.graceMs ?? 2000);
  const pollMs = Math.max(10, options.pollMs ?? 50);

  const signalled = pids.filter((pid) => signalProcess(pid, "SIGTERM", killImpl));
  const deadline = Date.now() + graceMs;
  let alive = signalled.filter((pid) => isProcessAlive(pid, platform));
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    alive = alive.filter((pid) => isProcessAlive(pid, platform));
  }

  const survivors = new Set(alive);
  for (const pid of options.rescan?.() ?? []) {
    survivors.add(pid);
  }
  const killed = [...survivors].filter((pid) => signalProcess(pid, "SIGKILL", killImpl));
  return { signalled: signalled.length, killed: killed.length };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
