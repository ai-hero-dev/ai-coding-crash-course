/**
 * install.ts — install a recipe's pinned agent under e2e/.tools/, never
 * globally, and never into the repo's own node_modules. A second run reuses
 * the install when the pinned version is already there.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TOOLS_DIR, log, type InstallResult } from "./driver";

const run = promisify(execFile);

function tail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err))
    .trim()
    .split("\n")
    .slice(-3)
    .join(" | ");
}

/** `npm install <pkg>@<version>` into e2e/.tools/<dir>. */
export async function npmTool(
  dir: string,
  pkg: string,
  version: string
): Promise<InstallResult> {
  const prefix = path.join(TOOLS_DIR, dir);
  const binDir = path.join(prefix, "node_modules", ".bin");
  const manifest = path.join(
    prefix,
    "node_modules",
    ...pkg.split("/"),
    "package.json"
  );
  const installed = () =>
    fs.existsSync(manifest)
      ? JSON.parse(fs.readFileSync(manifest, "utf8")).version
      : null;
  if (installed() === version) return { binDir, version };

  log(`installing ${pkg}@${version} into ${prefix}`);
  fs.mkdirSync(prefix, { recursive: true });
  // A package.json of its own, so npm installs here and not into the repo.
  const own = path.join(prefix, "package.json");
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
        prefix,
        `${pkg}@${version}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (err) {
    return { skip: `npm install ${pkg}@${version} failed: ${tail(err)}` };
  }
  return installed() === version
    ? { binDir, version }
    : { skip: `npm install ${pkg}@${version} did not leave ${manifest}` };
}

/** `pip install <pkg>==<version>` into a venv at e2e/.tools/<dir>. */
/** Whether `python` starts at all. */
async function runs(python: string): Promise<boolean> {
  try {
    await run(python, ["-c", ""]);
    return true;
  } catch {
    return false;
  }
}

export async function pipTool(
  dir: string,
  pkg: string,
  version: string
): Promise<InstallResult> {
  const venv = path.join(TOOLS_DIR, dir);
  const binDir = path.join(venv, "bin");
  const python = path.join(binDir, "python");
  if (process.platform === "win32")
    return { skip: "the pip recipes assume a POSIX venv layout" };
  try {
    await run("python3", ["-c", "import venv, ensurepip"]);
  } catch {
    return { skip: "python3 with venv and ensurepip is not available" };
  }
  try {
    const { stdout } = await run(python, ["-m", "pip", "show", pkg]);
    if (stdout.includes(`Version: ${version}`)) return { binDir, version };
  } catch {
    // not installed yet
  }
  log(`installing ${pkg}==${version} into ${venv}`);
  try {
    // A venv restored from a cache can outlive the Python it was built
    // with (its interpreter link then dangles): rebuild it when its own
    // python cannot run, instead of trusting that bin/pip exists.
    if (!(await runs(python)))
      await run("python3", ["-m", "venv", "--clear", venv]);
    await run(
      python,
      ["-m", "pip", "install", "--quiet", `${pkg}==${version}`],
      {
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (err) {
    return { skip: `pip install ${pkg}==${version} failed: ${tail(err)}` };
  }
  return { binDir, version };
}
