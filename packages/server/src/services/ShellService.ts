import { randomUUID } from "node:crypto";
import { type IPty, spawn } from "node-pty";

export type ShellState = "running" | "exited";

export interface ShellInfo {
  id: string;
  projectId: string;
  projectName: string;
  cwd: string;
  command: string;
  startedAt: string;
  exitedAt?: string;
  state: ShellState;
  exitCode?: number | null;
}

export interface ShellOutputChunk {
  seq: number;
  data: string;
}

type ShellSubscriber = (chunk: ShellOutputChunk) => void;

interface ShellRecord extends ShellInfo {
  process: IPty;
  seq: number;
  output: ShellOutputChunk[];
  subscribers: Set<ShellSubscriber>;
  lastActivityAt: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const EXITED_SHELL_TTL_MS = 5 * 60 * 1000;
const IDLE_RUNNING_SHELL_TTL_MS = 60 * 60 * 1000;

function getShellCommand(): { command: string; args: string[]; shell: string } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: [], shell: "cmd.exe" };
  }

  return { command: "/bin/bash", args: ["-i"], shell: "bash" };
}

export class ShellService {
  private readonly shells = new Map<string, ShellRecord>();

  private scheduleCleanup(record: ShellRecord, delayMs: number) {
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
    }
    record.cleanupTimer = setTimeout(() => {
      const latest = this.shells.get(record.id);
      if (!latest) return;

      if (latest.state === "exited") {
        this.disposeShell(latest.id);
        return;
      }

      const idleForMs = Date.now() - latest.lastActivityAt;
      if (idleForMs >= IDLE_RUNNING_SHELL_TTL_MS) {
        latest.process.kill();
        return;
      }

      this.scheduleCleanup(latest, IDLE_RUNNING_SHELL_TTL_MS - idleForMs);
    }, delayMs);
  }

  private bumpActivity(record: ShellRecord) {
    record.lastActivityAt = Date.now();
    if (record.state === "running") {
      this.scheduleCleanup(record, IDLE_RUNNING_SHELL_TTL_MS);
    }
  }

  private disposeShell(shellId: string) {
    const shell = this.shells.get(shellId);
    if (!shell) return;
    if (shell.cleanupTimer) {
      clearTimeout(shell.cleanupTimer);
    }
    shell.subscribers.clear();
    this.shells.delete(shellId);
  }

  createShell(params: {
    projectId: string;
    projectName: string;
    cwd: string;
  }): ShellInfo {
    const { command, args, shell: shellName } = getShellCommand();
    const proc = spawn(command, args, {
      cwd: params.cwd,
      env: process.env,
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });

    const shellId = randomUUID();
    const record: ShellRecord = {
      id: shellId,
      projectId: params.projectId,
      projectName: params.projectName,
      cwd: params.cwd,
      command: shellName,
      startedAt: new Date().toISOString(),
      state: "running",
      process: proc,
      seq: 0,
      output: [],
      subscribers: new Set(),
      lastActivityAt: Date.now(),
      cleanupTimer: null,
    };

    const appendOutput = (data: string) => {
      const text = data;
      if (!text) return;
      record.seq += 1;
      const chunk = { seq: record.seq, data: text };
      record.output.push(chunk);
      if (record.output.length > 500) {
        record.output.splice(0, record.output.length - 500);
      }
      this.bumpActivity(record);
      for (const subscriber of record.subscribers) {
        subscriber(chunk);
      }
    };

    proc.onData(appendOutput);
    proc.onExit(({ exitCode }) => {
      record.state = "exited";
      record.exitCode = exitCode;
      record.exitedAt = new Date().toISOString();
      record.seq += 1;
      record.output.push({
        seq: record.seq,
        data: `\r\n[Shell exited${exitCode === undefined ? "" : ` with code ${exitCode}`}]`,
      });
      const lastChunk = record.output[record.output.length - 1];
      if (lastChunk) {
        for (const subscriber of record.subscribers) {
          subscriber(lastChunk);
        }
      }
      this.scheduleCleanup(record, EXITED_SHELL_TTL_MS);
    });

    this.shells.set(shellId, record);
    this.scheduleCleanup(record, IDLE_RUNNING_SHELL_TTL_MS);
    return this.toShellInfo(record);
  }

  listShells(): ShellInfo[] {
    return Array.from(this.shells.values())
      .map((shell) => this.toShellInfo(shell))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getShell(shellId: string): ShellInfo | null {
    const shell = this.shells.get(shellId);
    return shell ? this.toShellInfo(shell) : null;
  }

  readOutput(
    shellId: string,
    afterSeq = 0,
  ): { chunks: ShellOutputChunk[] } | null {
    const shell = this.shells.get(shellId);
    if (!shell) return null;

    return {
      chunks: shell.output.filter((chunk) => chunk.seq > afterSeq),
    };
  }

  writeInput(shellId: string, data: string): boolean {
    const shell = this.shells.get(shellId);
    if (!shell || shell.state !== "running") return false;
    shell.process.write(data);
    this.bumpActivity(shell);
    return true;
  }

  subscribe(shellId: string, subscriber: ShellSubscriber): (() => void) | null {
    const shell = this.shells.get(shellId);
    if (!shell) return null;
    shell.subscribers.add(subscriber);
    this.bumpActivity(shell);
    return () => {
      shell.subscribers.delete(subscriber);
    };
  }

  resize(shellId: string, cols: number, rows: number): boolean {
    const shell = this.shells.get(shellId);
    if (!shell || shell.state !== "running") return false;
    const nextCols = Number.isFinite(cols)
      ? Math.max(1, Math.floor(cols))
      : DEFAULT_COLS;
    const nextRows = Number.isFinite(rows)
      ? Math.max(1, Math.floor(rows))
      : DEFAULT_ROWS;
    shell.process.resize(nextCols, nextRows);
    this.bumpActivity(shell);
    return true;
  }

  closeShell(shellId: string): boolean {
    const shell = this.shells.get(shellId);
    if (!shell) return false;

    if (shell.state === "running") {
      shell.process.kill();
    } else {
      this.disposeShell(shellId);
    }
    return true;
  }

  private toShellInfo(shell: ShellRecord): ShellInfo {
    return {
      id: shell.id,
      projectId: shell.projectId,
      projectName: shell.projectName,
      cwd: shell.cwd,
      command: shell.command,
      startedAt: shell.startedAt,
      exitedAt: shell.exitedAt,
      state: shell.state,
      exitCode: shell.exitCode,
    };
  }
}
