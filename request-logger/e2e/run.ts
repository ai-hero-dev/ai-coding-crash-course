/**
 * run.ts — run every e2e recipe whose agent installs here, and skip the rest
 * with a reason.
 *
 *     npm run request-logger:e2e                    # every recipe
 *     npm run request-logger:e2e -- codex pi        # recipes whose name starts so
 *     npm run request-logger:e2e -- --strict        # a skip fails the run (CI)
 *
 * Exits non-zero when any check fails, or, under --strict, when any recipe
 * was skipped. A failed run's scratch folder is kept and printed.
 */

import { log, removeScratch, runRecipe } from "./driver";
import { NO_RECIPE, RECIPES } from "./recipes";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const filters = args.filter((a) => !a.startsWith("--"));
  const recipes = RECIPES.filter(
    (r) => filters.length === 0 || filters.some((f) => r.name.startsWith(f))
  );
  if (recipes.length === 0)
    throw new Error(`no recipe matches ${filters.join(", ")}`);

  const summary: Array<[string, "PASS" | "FAIL" | "SKIP", string]> = [];
  for (const recipe of recipes) {
    console.log("");
    log(`=== ${recipe.name}`);
    const installed = await recipe.install();
    if ("skip" in installed) {
      log(`SKIP ${recipe.name}: ${installed.skip}`);
      summary.push([recipe.name, "SKIP", installed.skip]);
      continue;
    }
    log(`using ${recipe.name} ${installed.version}`);
    try {
      const result = await runRecipe(recipe, installed.binDir);
      for (const c of result.checks)
        console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
      const failed = result.checks.filter((c) => !c.ok);
      if (failed.length === 0) {
        removeScratch(result.scratch);
        summary.push([
          recipe.name,
          "PASS",
          `${installed.version}, ${result.checks.length} checks`,
        ]);
      } else {
        log(
          `upstream saw: ${result.seen.map((r) => `${r.method} ${r.url} -> ${r.answeredAs ?? 404}`).join(", ")}`
        );
        log(`log files: ${result.logFiles.join(", ")}`);
        summary.push([
          recipe.name,
          "FAIL",
          `${failed.length} check(s) failed; scratch kept at ${result.scratch}`,
        ]);
      }
    } catch (err) {
      summary.push([
        recipe.name,
        "FAIL",
        (err as Error).message.split("\n")[0],
      ]);
    }
  }

  console.log("");
  log("summary");
  for (const [name, status, detail] of summary)
    console.log(`  ${status}  ${name}  (${detail})`);
  if (filters.length === 0) {
    for (const [name, reason] of Object.entries(NO_RECIPE))
      console.log(`  ----  ${name}  (no recipe: ${reason})`);
  }
  const failed = summary.some(([, s]) => s === "FAIL");
  const skipped = summary.some(([, s]) => s === "SKIP");
  if (failed || (strict && skipped)) process.exit(1);
}

main().catch((err) => {
  console.error(`[e2e] ${(err as Error).message}`);
  process.exit(1);
});
