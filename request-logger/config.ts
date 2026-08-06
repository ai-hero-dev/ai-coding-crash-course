/**
 * config.ts — asks the student which agent they use, and remembers the answer.
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
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { listAgents, listProviders, type AgentChoice } from "./agents";

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

async function askFromList(
  rl: readline.Interface,
  question: string,
  options: Array<{ id: string; label: string; note?: string }>
): Promise<string> {
  console.log("");
  console.log(question);
  console.log("");
  options.forEach((option, i) => {
    const note = option.note ? `  (${option.note})` : "";
    console.log(`  ${i + 1}. ${option.label}${note}`);
  });
  console.log("");

  while (true) {
    const answer = (await rl.question(`Enter a number (1-${options.length}): `)).trim();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].id;
    }
    console.log("That is not one of the numbers. Try again.");
  }
}

export async function askChoice(): Promise<AgentChoice> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const agents = listAgents();
    const agentId = await askFromList(
      rl,
      "Which coding agent do you use?",
      agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        note: agent.supported ? undefined : "cannot be logged",
      }))
    );

    const providers = listProviders(agentId);
    if (providers.length === 0) return { agent: agentId };

    const agentLabel = agents.find((a) => a.id === agentId)?.label ?? agentId;
    const providerId = await askFromList(
      rl,
      `${agentLabel} can use more than one model provider. Which one do you use?`,
      providers
    );
    return { agent: agentId, provider: providerId };
  } finally {
    rl.close();
  }
}
