import { claudeCode, interactive } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

await interactive({
  agent: claudeCode("claude-opus-4-6"),
  sandbox: noSandbox(),
  promptFile: "./.sandcastle/prompt.md",
});
