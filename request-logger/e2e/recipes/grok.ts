import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TOOLS_DIR, log, type InstallResult, type Recipe } from "../driver";

const VERSION = "1.0.70";
const run = promisify(execFile);

/**
 * Grok CLI is not on npm. xAI's installer (https://x.ai/cli/install.sh)
 * downloads one static binary per platform from
 * https://x.ai/cli/grok-<version>-<os>-<arch>; this fetches the pinned one
 * the same way, into e2e/.tools/grok/, never onto PATH.
 */
async function installGrok(): Promise<InstallResult> {
  const os = { linux: "linux", darwin: "macos" }[process.platform as string];
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch as string];
  if (!os || !arch)
    return {
      skip: `no Grok CLI build for ${process.platform}-${process.arch}`,
    };
  const binDir = path.join(TOOLS_DIR, "grok", VERSION);
  const bin = path.join(binDir, "grok");
  if (fs.existsSync(bin)) return { binDir, version: VERSION };
  const url = `https://x.ai/cli/grok-${VERSION}-${os}-${arch}`;
  log(`downloading ${url} into ${binDir}`);
  fs.mkdirSync(binDir, { recursive: true });
  try {
    await run("curl", ["-fsSL", "-o", `${bin}.tmp`, url]);
    fs.chmodSync(`${bin}.tmp`, 0o755);
    fs.renameSync(`${bin}.tmp`, bin);
  } catch (err) {
    return { skip: `downloading ${url} failed: ${(err as Error).message}` };
  }
  return { binDir, version: VERSION };
}

/**
 * Grok on the xAI route, with a dummy XAI_API_KEY instead of a grok.com
 * login. This is the run that settles #54's claim that an API key also
 * talks to cli-chat-proxy.grok.com: if Grok sends API-key traffic to
 * xai_api_base_url (https://api.x.ai/v1) instead, nothing reaches the fake
 * and the model-path check fails.
 *
 * NOT RUN, so not in RECIPES: on 2026-11-05 the verifying agent was not
 * permitted to download and execute the x.ai binary. The flags below (`-p`
 * for one prompt, XAI_API_KEY) come from the PR body and the binary's
 * strings, not a run. See NO_RECIPE["grok/xai"].
 */
export const grok: Recipe = {
  name: "grok/xai",
  choice: { agent: "grok", provider: "xai" },
  install: installGrok,
  env: ({ key }) => ({ XAI_API_KEY: key }),
  promptArgs: (prompt) => ["-p", prompt],
  modelPath: /^\/v1\/(responses|chat\/completions)$/,
};
