/**
 * config.ts — asks the student which agent they use, and remembers the answer
 * only if they ask it to.
 *
 * The saved file holds the choice and nothing else. It never holds a host, a
 * renderer or a command, because those are worked out from the catalogue every
 * time the tool starts. A change to the catalogue therefore reaches a student
 * who already has a saved file, without them having to clear anything.
 *
 * This is glue, not logic. The decisions all live in agents.ts, which is where
 * the tests are.
 */

import fs from "node:fs";
import { styleText } from "node:util";
import { cancel, confirm, isCancel, intro, select, text } from "@clack/prompts";
import {
  listAgents,
  listProviders,
  OTHER_ID,
  OTHER_LABEL,
  localUpstream,
  type AgentChoice,
} from "./agents";
import { probeLocalServer, type LocalProbe } from "./local";

export interface WizardAnswer {
  choice: AgentChoice;
  /** True only when the choice is to be kept. */
  remember: boolean;
}

export interface AskOptions {
  /**
   * Whether to ask if the answer should be kept.
   *
   * False when the student has already answered that question. Running with
   * --force replaces a preference they chose to keep, so asking again would
   * only make them say yes twice.
   */
  offerToRemember: boolean;
}

export function loadChoice(file: string): AgentChoice | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed?.agent !== "string") return null;
    return {
      agent: parsed.agent,
      provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
      localUrl: typeof parsed.localUrl === "string" ? parsed.localUrl : undefined,
      localModel: typeof parsed.localModel === "string" ? parsed.localModel : undefined,
    };
  } catch {
    return null;
  }
}

export function saveChoice(file: string, choice: AgentChoice): void {
  try {
    fs.writeFileSync(file, JSON.stringify(choice, null, 2) + "\n");
  } catch (err) {
    console.warn(
      `[request-logger] could not save your choice: ${(err as Error).message}`
    );
    console.warn("[request-logger] you will be asked again next time.");
  }
}

/**
 * Forget a remembered answer.
 *
 * --force clears the file before it asks. Without this, a student who forces a
 * new choice and then picks an agent that cannot be logged keeps the old answer,
 * because a refused agent is never saved. The next plain run would then start
 * the agent they were trying to move away from.
 */
export function clearChoice(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.warn(
      `[request-logger] could not forget your saved choice: ${(err as Error).message}`
    );
  }
}

/** Ctrl+C at any prompt leaves without starting a server. */
function stopIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    // The saved answer is not mentioned. A student who leaves does not need a
    // report on a file they never asked for.
    cancel("No problem. Nothing was started.");
    process.exit(0);
  }
  return value as T;
}

export async function askChoice(options: AskOptions): Promise<WizardAnswer> {
  intro(styleText("bold", " request-logger "));

  const agents = listAgents();
  const agentId = stopIfCancelled(
    await select({
      message: "Which coding agent do you use?",
      options: [
        ...agents.map((agent) => ({
          value: agent.id,
          label: agent.label,
          hint: agent.supported ? undefined : "cannot be logged",
        })),
        { value: OTHER_ID, label: OTHER_LABEL, hint: "ask for it" },
      ],
    })
  );

  // "Other" ends the wizard. There is no provider to ask about, and nothing to
  // remember.
  if (agentId === OTHER_ID) return { choice: { agent: OTHER_ID }, remember: false };

  const agent = agents.find((a) => a.id === agentId);
  const providers = listProviders(agentId);

  let choice: AgentChoice = { agent: agentId };
  if (providers.length > 0) {
    const providerId = stopIfCancelled(
      await select({
        message: `${agent?.label ?? agentId} can use more than one model provider. Which one do you use?`,
        options: [
          ...providers.map((provider) => ({
            value: provider.id,
            label: provider.label,
          })),
          { value: OTHER_ID, label: OTHER_LABEL },
        ],
      })
    );
    choice = { agent: agentId, provider: providerId };
    if (providerId === OTHER_ID) return { choice, remember: false };
  }

  // A local model server lives on the student's machine, so its address is not
  // in the catalogue. Ask for it, confirm it answers, and pick the model to
  // use. Without a reachable server there is nothing to forward to, so the
  // wizard refuses to finish rather than guess.
  const picked = providers.find((p) => p.id === choice.provider);
  if (picked?.local) {
    let probe: LocalProbe = { ok: false, models: [] };
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = stopIfCancelled(
        await text({
          message: "Address of your local model server",
          placeholder: "http://127.0.0.1:8000",
        })
      );
      const url = raw.trim();
      if (url.length === 0) continue;
      let root: string;
      try {
        const { scheme, host, port, prefix } = localUpstream(url);
        root = `${scheme}://${host}:${port}${prefix}`;
      } catch (err) {
        console.error(`  ${styleText("dim", (err as Error).message)}`);
        continue;
      }
      probe = await probeLocalServer(root);
      if (probe.ok) {
        choice = { ...choice, localUrl: root, localModel: probe.models[0] };
        break;
      }
      console.error(`  ${styleText("dim", probe.error ?? "could not reach the server")}`);
    }
    if (!probe.ok || probe.models.length === 0) {
      cancel("Could not reach a local model server. Nothing was started.");
      process.exit(1);
    }
    if (probe.models.length > 1) {
      const model = stopIfCancelled(
        await select({
          message: "Which model is that server running?",
          options: probe.models.map((id) => ({ value: id, label: id })),
          initialValue: probe.models[0],
        })
      );
      choice = { ...choice, localModel: model };
    }
  }

  // An agent that cannot be logged is a dead end. Saving it would only make the
  // student clear the file before they could try a different one, so the
  // question is not asked at all.
  if (agent && !agent.supported) return { choice, remember: false };

  if (!options.offerToRemember) return { choice, remember: true };

  const remember = stopIfCancelled(
    await confirm({
      message: `Remember this for next time?\n${styleText(
        "dim",
        "  Choose no if you regularly swap coding agents."
      )}`,
      initialValue: true,
    })
  );

  return { choice, remember };
}
