/**
 * sync-antigravity-to-langfuse.ts
 *
 * Reads the Antigravity IDE conversation transcript and syncs all conversation
 * turns, tool calls, and agent responses to Langfuse under a single grouped session
 * using the Langfuse v4 observations-first data model.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  propagateAttributes,
} from "@langfuse/tracing";

// Automatically load .env if present
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // ignore
}

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl =
  process.env.LANGFUSE_BASE_URL ??
  process.env.LANGFUSE_HOST ??
  "https://cloud.langfuse.com";

if (!publicKey || !secretKey) {
  console.error("Langfuse keys missing in environment or .env file.");
  process.exit(1);
}

const spanProcessor = new LangfuseSpanProcessor({
  publicKey,
  secretKey,
  baseUrl,
  exportMode: "immediate",
});

const sdk = new NodeSDK({
  spanProcessors: [spanProcessor],
});
sdk.start();

async function syncTranscript(conversationId?: string) {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
  
  // Find conversation directory
  let targetConvId = conversationId;
  if (!targetConvId && fs.existsSync(brainDir)) {
    const convs = fs.readdirSync(brainDir).filter((f) => {
      const p = path.join(brainDir, f, ".system_generated", "logs", "transcript.jsonl");
      return fs.existsSync(p);
    });
    // Pick the most recently modified conversation
    if (convs.length > 0) {
      convs.sort((a, b) => {
        const statA = fs.statSync(path.join(brainDir, a, ".system_generated", "logs", "transcript.jsonl"));
        const statB = fs.statSync(path.join(brainDir, b, ".system_generated", "logs", "transcript.jsonl"));
        return statB.mtimeMs - statA.mtimeMs;
      });
      targetConvId = convs[0];
    }
  }

  if (!targetConvId) {
    console.error("No Antigravity conversation transcript found.");
    return;
  }

  const transcriptPath = path.join(brainDir, targetConvId, ".system_generated", "logs", "transcript.jsonl");
  console.log(`Reading transcript from: ${transcriptPath}`);

  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const steps: any[] = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line));
    } catch {
      // skip invalid lines
    }
  }

  console.log(`Total transcript steps: ${steps.length}`);

  // Group steps by conversation turns
  interface Turn {
    index: number;
    userInput: string;
    createdAt: string;
    toolCalls: Array<{ name: string; args: any; output?: string }>;
    assistantResponse: string;
  }

  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let turnCounter = 1;

  for (const step of steps) {
    if (step.type === "USER_INPUT") {
      let rawContent = step.content ?? "";
      const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
      const cleanInput = match ? match[1].trim() : rawContent;

      currentTurn = {
        index: turnCounter++,
        userInput: cleanInput,
        createdAt: step.created_at || new Date().toISOString(),
        toolCalls: [],
        assistantResponse: "",
      };
      turns.push(currentTurn);
    } else if (currentTurn) {
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          let parsedArgs = tc.args;
          if (typeof tc.args === "string") {
            try { parsedArgs = JSON.parse(tc.args); } catch { /* keep raw */ }
          }
          currentTurn.toolCalls.push({ name: tc.name, args: parsedArgs });
        }
      }
      if (step.content && step.source === "MODEL" && step.type === "PLANNER_RESPONSE") {
        currentTurn.assistantResponse += step.content + "\n";
      }
      if (step.content && step.source === "MODEL" && step.type !== "PLANNER_RESPONSE") {
        // Tool execution result
        const lastTool = currentTurn.toolCalls[currentTurn.toolCalls.length - 1];
        if (lastTool && !lastTool.output) {
          lastTool.output = step.content.slice(0, 1000); // cap size
        }
      }
    }
  }

  console.log(`Found ${turns.length} conversation turns to sync to session '${targetConvId}'...`);

  for (const turn of turns) {
    await propagateAttributes(
      {
        traceName: `Antigravity IDE - Turn ${turn.index}`,
        sessionId: `antigravity_${targetConvId}`,
        tags: ["antigravity-ide", "chat-canvas"],
        metadata: {
          conversationId: targetConvId.slice(0, 200),
          turn: String(turn.index),
          toolCallsCount: String(turn.toolCalls.length),
        },
      },
      async () => {
        const rootSpan = startObservation(`Antigravity IDE - Turn ${turn.index}`, {
          input: { prompt: turn.userInput },
          output: {
            response: turn.assistantResponse.trim() || "(Tool executions / in progress)",
            toolCalls: turn.toolCalls.map((tc) => tc.name),
          },
          metadata: {
            conversationId: targetConvId,
            turn: turn.index,
            toolCallsCount: turn.toolCalls.length,
          },
        });

        const generation = rootSpan.startObservation(
          "Antigravity Model Response",
          {
            model: "gemini-3.7-flash",
            input: turn.userInput,
            output: turn.assistantResponse.trim() || "(Tool execution and actions completed)",
            metadata: {
              turn: turn.index,
              tools: turn.toolCalls.map((tc) => tc.name),
            },
          },
          { asType: "generation" }
        );
        generation.end();

        for (const tc of turn.toolCalls) {
          const toolSpan = rootSpan.startObservation(
            `Tool: ${tc.name}`,
            {
              input: tc.args,
              output: tc.output ?? "completed",
            },
            { asType: "tool" }
          );
          toolSpan.end();
        }

        rootSpan.end();
      }
    );
  }

  await spanProcessor.forceFlush();
  await spanProcessor.shutdown();
  console.log(`Successfully synced Antigravity IDE chat session '${targetConvId}' with ${turns.length} turns to Langfuse!`);
}

syncTranscript().catch(console.error);
