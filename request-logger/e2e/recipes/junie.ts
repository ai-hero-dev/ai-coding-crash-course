import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TOOLS_DIR, log, type InstallResult, type Recipe } from "../driver";
import { FAKE_MODEL } from "../fake-upstream";

const VERSION = "3110.7.0";
const run = promisify(execFile);
const PREFIX = path.join(TOOLS_DIR, "junie");
/** Junie's postinstall writes to os.homedir(), so it gets a HOME of its own here. */
const INSTALL_HOME = path.join(PREFIX, "home");
const JUNIE_DATA = path.join(INSTALL_HOME, ".local", "share", "junie");

/**
 * `@jetbrains/junie` is a closed-source wrapper: its postinstall downloads
 * junie-release-<v>-<os>-<arch>.zip from github.com/JetBrains/junie releases
 * (no account needed) and installs a shim to ~/.local/bin. npmTool would
 * let that land in the real home, so this installs with HOME redirected.
 */
async function installJunie(): Promise<InstallResult> {
  const binDir = path.join(INSTALL_HOME, ".local", "bin");
  const manifest = path.join(
    PREFIX,
    "node_modules",
    "@jetbrains",
    "junie",
    "package.json"
  );
  const installed = () =>
    fs.existsSync(manifest) && fs.existsSync(path.join(binDir, "junie"))
      ? JSON.parse(fs.readFileSync(manifest, "utf8")).version
      : null;
  if (installed() === VERSION) return { binDir, version: VERSION };
  log(`installing @jetbrains/junie@${VERSION} into ${PREFIX}`);
  fs.mkdirSync(INSTALL_HOME, { recursive: true });
  const own = path.join(PREFIX, "package.json");
  if (!fs.existsSync(own)) fs.writeFileSync(own, `{ "private": true }\n`);
  try {
    await run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-save",
        "--prefix",
        PREFIX,
        `@jetbrains/junie@${VERSION}`,
      ],
      {
        env: { ...process.env, HOME: INSTALL_HOME },
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (err) {
    return {
      skip: `npm install @jetbrains/junie@${VERSION} failed: ${(err as Error).message}`,
    };
  }
  return installed() === VERSION
    ? { binDir, version: VERSION }
    : {
        skip: `@jetbrains/junie@${VERSION} did not install its shim to ${binDir}`,
      };
}

/**
 * Junie on its Anthropic-compatible custom-model profile, with a dummy
 * ANTHROPIC_API_KEY that the profile's `${ANTHROPIC_API_KEY}` header pulls
 * from the environment. The extra checks are #48's two bug fixes: one
 * anthropic-version header, not two joined with a comma, and the profile's
 * `id` sent as the model.
 *
 * NOT RUN, so not in RECIPES. On 2026-11-05 the install worked headlessly
 * (3110.7.0, HOME redirected), but the verifying agent was not permitted
 * to execute the closed-source binary. Two unknowns for the first run:
 *   - the prompt is a positional argument (`junie --auth=… "Fix any failing
 *     tests"` in the docs embedded in the jar);
 *   - a one-shot run ends at the model's first `answer_to_chat` tool call
 *     (the jar's system prompt), so a plain-text reply may not end the run:
 *     the fake upstream may need a tool-call reply shape for Junie.
 * See NO_RECIPE.junie.
 */
export const junie: Recipe = {
  name: "junie",
  choice: {
    agent: "junie",
    customBaseUrl: "https://api.anthropic.com",
    customRenderer: "anthropic",
    customModel: FAKE_MODEL,
  },
  install: installJunie,
  env: ({ key }) => ({
    ANTHROPIC_API_KEY: key,
    JUNIE_DATA,
    JUNIE_SKIP_UPDATE_CHECK: "1",
  }),
  promptArgs: (prompt) => [prompt],
  modelPath: /^\/v1\/messages$/,
  extraChecks: ({ seen }) => {
    const calls = seen.filter((r) =>
      /\/v1\/messages$/.test(r.url.split("?")[0])
    );
    return [
      {
        name: "one anthropic-version header, not two joined with a comma",
        ok:
          calls.length > 0 &&
          calls.every(
            (r) => !String(r.headers["anthropic-version"] ?? "").includes(",")
          ),
      },
      {
        name: "the profile's id is sent as the model",
        ok:
          calls.length > 0 &&
          calls.every((r) => JSON.parse(r.body || "{}").model === FAKE_MODEL),
      },
    ];
  },
  timeoutMs: 300_000,
};
