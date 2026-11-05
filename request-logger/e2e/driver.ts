/**
 * driver.ts — the agent-agnostic half of the e2e harness.
 *
 * One run of one recipe:
 *
 *   1. start the fake upstream (fake-upstream.ts);
 *   2. start the real, unmodified proxy.ts, with a saved choice for the
 *      recipe's registry entry and the two test-only overrides
 *      (REQUEST_LOGGER_TEST_DIR, REQUEST_LOGGER_TEST_UPSTREAM) pointing its
 *      state at a scratch folder and its upstream at the fake;
 *   3. read the command the banner printed, check it is the command
 *      resolveChoice builds for that entry, and write any setup file the
 *      banner asked for into a scratch HOME;
 *   4. run that exact command, with the recipe's prompt arguments appended
 *      and a dummy key in the environment;
 *   5. check the agent printed the canned reply, the model call arrived on
 *      the path the real host would have seen, and the capture shows the
 *      request and the response with the key redacted.
 *
 * Everything an agent needs that is not in the printed command — how to
 * install it, how to make it run one prompt and exit, which dummy key it
 * reads — lives in its recipe (recipes/*.ts), never here.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChoice, type AgentChoice } from "../agents";
import { saveChoice } from "../config";
import { TEST_DIR_ENV, TEST_UPSTREAM_ENV } from "../proxy";
import {
  CANNED_REPLY,
  startFakeUpstream,
  type ChatFlavor,
  type FakeUpstream,
  type SeenRequest,
} from "./fake-upstream";

export const DUMMY_KEY = "sk-e2e-dummy-key-0123456789abcdef";
export const PROMPT = "Say hello to the request-logger e2e test.";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOGGER_DIR = path.dirname(HERE);
export const REPO = path.dirname(LOGGER_DIR);
/** Where recipes install their pinned agents. Gitignored. */
export const TOOLS_DIR = path.join(HERE, ".tools");

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export type InstallResult =
  { binDir: string; version: string } | { skip: string };

export interface RunContext {
  /** The scratch HOME the agent runs under. */
  home: string;
  /** The key every recipe hands its agent. Never a real one. */
  key: string;
}

export interface Recipe {
  /** Unique, e.g. "claude-code/anthropic". */
  name: string;
  /** The registry entry, exactly as the wizard would save it. */
  choice: AgentChoice;
  /** The chat/completions shape the fake answers in. Default "openai". */
  chat?: ChatFlavor;
  /** Install the pinned agent under TOOLS_DIR, or say why it cannot be. */
  install(): Promise<InstallResult>;
  /** What the agent needs in its environment besides the printed command. */
  env(ctx: RunContext): Record<string, string>;
  /** Appended to the printed command so it runs one prompt and exits. */
  promptArgs(prompt: string): string[];
  /** The path the agent's model call must reach the upstream on. */
  modelPath: RegExp;
  /** Extra files the agent needs in the scratch HOME (not the banner's setup files). */
  files?(ctx: RunContext): Record<string, string>;
  /**
   * False for a route that sends no credential at all (Claude Code on Vertex
   * with CLAUDE_CODE_SKIP_VERTEX_AUTH), so the key checks do not apply.
   * Say why next to it. Default true.
   */
  sendsKey?: boolean;
  /** Checks only this agent needs, run after the shared ones. */
  extraChecks?(run: { capture: string; seen: SeenRequest[] }): Check[];
  /** Default 120s. */
  timeoutMs?: number;
}

export interface Check {
  name: string;
  ok: boolean;
}

export interface RunResult {
  checks: Check[];
  command: string;
  agentOutput: string;
  scratch: string;
  seen: SeenRequest[];
  logFiles: string[];
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The proxy's own files, as a student has them, so a run can prove it left them alone. */
function studentState(): string {
  const logs = path.join(LOGGER_DIR, "logs");
  const choice = path.join(LOGGER_DIR, ".agent-choice.json");
  return JSON.stringify({
    logs: fs.existsSync(logs) ? fs.readdirSync(logs).sort() : null,
    choice: fs.existsSync(choice) ? fs.readFileSync(choice, "utf8") : null,
  });
}

export interface StartedProxy {
  proxy: ChildProcess;
  command: string;
  banner: string;
  stop(): void;
}

/**
 * Start the real proxy.ts — the same file `npm run request-logger` runs —
 * with its state in `stateDir` and its upstream redirected to `upstream`.
 * Resolves once the banner has printed the command.
 */
export function startProxy(opts: {
  stateDir: string;
  upstream: string;
  port: number;
  choice: AgentChoice;
}): Promise<StartedProxy> {
  fs.mkdirSync(opts.stateDir, { recursive: true });
  saveChoice(path.join(opts.stateDir, ".agent-choice.json"), opts.choice);

  const proxy = spawn(
    path.join(REPO, "node_modules", ".bin", "tsx"),
    [path.join(LOGGER_DIR, "proxy.ts")],
    {
      env: {
        ...process.env,
        PORT: String(opts.port),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        [TEST_DIR_ENV]: opts.stateDir,
        [TEST_UPSTREAM_ENV]: opts.upstream,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let banner = "";
  const stop = () => {
    if (proxy.exitCode === null) proxy.kill();
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`proxy never printed its banner:\n${banner}`));
    }, 30_000);
    proxy.stderr!.on("data", (d) => (banner += d));
    proxy.stdout!.on("data", (d) => {
      banner += d;
      const plain = banner.replace(/\x1b\[[0-9;]*m/g, "");
      const match = plain.match(
        /[Rr]un your agent in another terminal with:\n\n\s+(.+)\n/
      );
      if (match && plain.includes("Ctrl+C")) {
        clearTimeout(timer);
        resolve({ proxy, command: match[1].trim(), banner: plain, stop });
      }
    });
    proxy.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited ${code}:\n${banner}`));
    });
  });
}

/** `~/.pi/agent/models.json` -> `<home>/.pi/agent/models.json`. */
function inHome(home: string, file: string): string {
  return file.startsWith("~/")
    ? path.join(home, file.slice(2))
    : path.join(home, file);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the printed command, unchanged, with the prompt arguments after it.
 * Asynchronous on purpose: the fake upstream lives in this process, so a
 * synchronous child would block it and the agent would time out.
 */
function runAgent(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const line = [opts.command, ...opts.args.map(shellQuote)].join(" ");
  const child = spawn("/bin/sh", ["-c", line], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stderr += `\n[e2e] timed out after ${opts.timeoutMs}ms`;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, opts.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Delete a scratch folder. Some agents (Mistral Vibe) leave read-only files
 * and folders behind, so write permission is restored first.
 */
export function removeScratch(dir: string): void {
  const restore = (p: string) => {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(p, stat.mode | 0o700);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) restore(path.join(p, entry));
    }
  };
  if (!fs.existsSync(dir)) return;
  restore(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export async function runRecipe(
  recipe: Recipe,
  binDir: string
): Promise<RunResult> {
  const before = studentState();
  const scratch = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `request-logger-e2e-${recipe.name.replace(/\W+/g, "-")}-`
    )
  );
  const stateDir = path.join(scratch, "state");
  const home = path.join(scratch, "home");
  const project = path.join(scratch, "project");
  for (const dir of [home, project]) fs.mkdirSync(dir, { recursive: true });
  const ctx: RunContext = { home, key: DUMMY_KEY };

  const upstream: FakeUpstream = await startFakeUpstream({ chat: recipe.chat });
  const port = await freePort();
  let proxy: StartedProxy | undefined;
  try {
    proxy = await startProxy({
      stateDir,
      upstream: upstream.origin,
      port,
      choice: recipe.choice,
    });
    log(`proxy on :${port} -> fake upstream ${upstream.origin}`);
    log(`wizard printed: ${proxy.command}`);

    const expected = resolveChoice(recipe.choice, {
      port,
      platform: process.platform,
    });
    if (expected.kind !== "target" && expected.kind !== "custom-target") {
      throw new Error(
        `${recipe.name}: the choice resolves to ${expected.kind}, not a target`
      );
    }

    // The banner's setup files, written where the student would put them.
    for (const file of expected.setup) {
      const dest = inHome(home, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.body);
    }
    for (const [file, body] of Object.entries(recipe.files?.(ctx) ?? {})) {
      const dest = inHome(home, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
    }

    const run = await runAgent({
      command: proxy.command,
      args: recipe.promptArgs(PROMPT),
      cwd: project,
      timeoutMs: recipe.timeoutMs ?? 120_000,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        TMPDIR: os.tmpdir(),
        TERM: "dumb",
        NO_COLOR: "1",
        ...recipe.env(ctx),
      },
    });
    const agentOutput = `${run.stdout}\n${run.stderr}`;
    log(`agent exited ${run.code}; stdout: ${run.stdout.trim().slice(0, 200)}`);
    // The proxy writes its files once the response ends; give it a beat.
    await new Promise((r) => setTimeout(r, 750));

    const logsDir = path.join(stateDir, "logs");
    const logFiles = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir).sort()
      : [];
    const read = (f: string) => fs.readFileSync(path.join(logsDir, f), "utf8");
    const captures = logFiles.filter((f) => f.endsWith(".md")).map(read);
    const everything = logFiles.map(read).join("\n");
    const modelCalls = upstream.seen.filter(
      (r) =>
        r.answeredAs &&
        r.answeredAs !== "models" &&
        recipe.modelPath.test(r.url.split("?")[0])
    );
    const turn = captures.find((c) => c.includes(PROMPT)) ?? "";
    const streamed = modelCalls.some((r) => r.streamed);

    const checks: Check[] = [
      {
        name: "the banner printed the command resolveChoice builds for this entry",
        ok: proxy.command === expected.command,
      },
      {
        name: "the banner printed every setup file it asked for",
        ok: expected.setup.every((f) =>
          f.body.split("\n").every((line) => proxy!.banner.includes(line))
        ),
      },
      { name: "the agent exited 0", ok: run.code === 0 },
      {
        name: "the agent printed the canned reply",
        ok: run.stdout.includes(CANNED_REPLY),
      },
      {
        name: `the model call reached the upstream on ${recipe.modelPath}`,
        ok: modelCalls.length > 0,
      },
      ...(recipe.sendsKey === false
        ? []
        : [
            {
              name: "the dummy key reached the upstream, so auth passes through",
              ok: modelCalls.some((r) =>
                JSON.stringify(r.headers).includes(DUMMY_KEY)
              ),
            },
          ]),
      {
        name: "a readable capture shows the prompt (request logged)",
        ok: turn !== "",
      },
      {
        name: "that capture shows the canned reply (response logged)",
        ok: turn.includes(CANNED_REPLY),
      },
      {
        name: streamed
          ? "the streamed reply is reassembled into <assistant-text>"
          : "(not streamed) the reply is in the capture",
        ok: streamed
          ? turn.includes(`<assistant-text>\n\n${CANNED_REPLY}`)
          : turn.includes(CANNED_REPLY),
      },
      ...(recipe.sendsKey === false
        ? []
        : [
            {
              name: "the capture redacts the key header",
              ok: turn.includes("[REDACTED]"),
            },
          ]),
      {
        name: "the dummy key appears in no log file",
        ok: !everything.includes(DUMMY_KEY),
      },
      {
        name: "the student's own .agent-choice.json and logs/ are untouched",
        ok: studentState() === before,
      },
      ...(recipe.extraChecks?.({ capture: turn, seen: upstream.seen }) ?? []),
    ];
    if (!checks.find((c) => c.name.startsWith("the agent exited"))!.ok) {
      log(`agent output:\n${agentOutput.slice(-4000)}`);
    }
    return {
      checks,
      command: proxy.command,
      agentOutput,
      scratch,
      seen: upstream.seen,
      logFiles,
    };
  } finally {
    proxy?.stop();
    await upstream.close();
  }
}
