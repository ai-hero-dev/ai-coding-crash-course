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
import { cancel, confirm, isCancel, intro, select } from "@clack/prompts";
import { listAgents, listProviders, type AgentChoice } from "./agents";

export interface WizardAnswer {
  choice: AgentChoice;
  /** True only when the student asked for the choice to be kept. */
  remember: boolean;
}

export function loadChoice(file: string): AgentChoice | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed?.agent !== "string") return null;
    return {
      agent: parsed.agent,
      provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
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

/** Ctrl+C at any prompt leaves without starting a server. */
function stopIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("No problem. Nothing was started, and nothing was saved.");
    process.exit(0);
  }
  return value as T;
}

export async function askChoice(): Promise<WizardAnswer> {
  intro(styleText("bold", " request-logger "));

  const agents = listAgents();
  const agentId = stopIfCancelled(
    await select({
      message: "Which coding agent do you use?",
      options: agents.map((agent) => ({
        value: agent.id,
        label: agent.label,
        hint: agent.supported ? undefined : "cannot be logged",
      })),
    })
  );

  const agent = agents.find((a) => a.id === agentId);
  const providers = listProviders(agentId);

  let choice: AgentChoice = { agent: agentId };
  if (providers.length > 0) {
    const providerId = stopIfCancelled(
      await select({
        message: `${agent?.label ?? agentId} can use more than one model provider. Which one do you use?`,
        options: providers.map((provider) => ({
          value: provider.id,
          label: provider.label,
        })),
      })
    );
    choice = { agent: agentId, provider: providerId };
  }

  // An agent that cannot be logged is a dead end. Saving it would only make the
  // student clear the file before they could try a different one, so the
  // question is not asked at all.
  if (agent && !agent.supported) return { choice, remember: false };

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
