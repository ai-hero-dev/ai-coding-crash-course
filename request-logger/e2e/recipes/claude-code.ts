import crypto from "node:crypto";
import { authorizationFor } from "../../bedrock";
import { DUMMY_KEY, type Recipe } from "../driver";
import { npmTool } from "../install";

const VERSION = "2.1.318";

/** Claude Code on the Anthropic route, with a dummy API key instead of a login. */
export const claudeCode: Recipe = {
  name: "claude-code/anthropic",
  choice: { agent: "claude-code", provider: "anthropic" },
  install: () => npmTool("claude-code", "@anthropic-ai/claude-code", VERSION),
  env: ({ key }) => ({
    ANTHROPIC_API_KEY: key,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }),
  promptArgs: (prompt) => ["-p", prompt],
  modelPath: /^\/v1\/messages$/,
};

/**
 * Claude Code on Vertex AI (global). CLAUDE_CODE_SKIP_VERTEX_AUTH is Claude
 * Code's own switch for running behind a gateway that adds auth, so it
 * needs no Google credentials, and sends none: the key checks are off.
 *
 * Claude Code sends /projects/… with no /v1 when ANTHROPIC_VERTEX_BASE_URL
 * is set; the entry's upstream path prefix (#122) puts the /v1 back, so the
 * call reaches the upstream on /v1/projects/…, the path real Vertex serves.
 */
export const claudeCodeVertex: Recipe = {
  name: "claude-code/vertex",
  choice: { agent: "claude-code", provider: "vertex", region: "global" },
  install: claudeCode.install,
  env: () => ({
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    CLOUD_ML_REGION: "global",
    ANTHROPIC_VERTEX_PROJECT_ID: "e2e-project",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }),
  promptArgs: claudeCode.promptArgs,
  modelPath:
    /^\/v1\/projects\/[^/]+\/locations\/global\/publishers\/anthropic\/models\/[^/]+:streamRawPredict$/,
  sendsKey: false,
};

export const E2E_AWS_KEY_ID = "AKIDE2EEXAMPLE000000";
export const E2E_AWS_SECRET = "e2e-secret-access-key-not-a-real-one";
export const E2E_AWS_SESSION_TOKEN = "e2e-session-token-not-a-real-one";

const bedrockAgentEnv = {
  CLAUDE_CODE_USE_BEDROCK: "1",
  AWS_REGION: "us-east-1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

const BEDROCK_MODEL_PATH = /^\/model\/[^/]+\/invoke-with-response-stream$/;

export const claudeCodeBedrock: Recipe = {
  name: "claude-code/bedrock",
  choice: { agent: "claude-code", provider: "bedrock" },
  install: claudeCode.install,
  proxyEnv: () => ({
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: E2E_AWS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: E2E_AWS_SECRET,
    AWS_SESSION_TOKEN: E2E_AWS_SESSION_TOKEN,
  }),
  env: () => bedrockAgentEnv,
  promptArgs: claudeCode.promptArgs,
  modelPath: BEDROCK_MODEL_PATH,
  sendsKey: false,
  extraChecks: ({ seen, logs }) => {
    const calls = seen.filter((r) => BEDROCK_MODEL_PATH.test(r.url));
    const signed = calls.filter((r) =>
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${E2E_AWS_KEY_ID}/\\d{8}/us-east-1/bedrock/aws4_request, ` +
          "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
          "Signature=[0-9a-f]{64}$"
      ).test(String(r.headers.authorization))
    );
    return [
      {
        name: "every request Claude Code made was a POST, which the signing route requires",
        ok: seen.length > 0 && seen.every((r) => r.method === "POST"),
      },
      {
        name: "the proxy signed every model call for bedrock in us-east-1",
        ok: calls.length > 0 && signed.length === calls.length,
      },
      {
        name: "each signature verifies against the host, path, headers and body the upstream received",
        ok:
          calls.length > 0 &&
          calls.every((r) => {
            const date = String(r.headers["x-amz-date"]);
            return (
              r.headers.authorization ===
              authorizationFor({
                method: r.method,
                path: r.url,
                headers: {
                  host: String(r.headers.host),
                  "x-amz-content-sha256": crypto.createHash("sha256").update(r.body).digest("hex"),
                  "x-amz-date": date,
                  "x-amz-security-token": E2E_AWS_SESSION_TOKEN,
                },
                payloadHash: crypto.createHash("sha256").update(r.body).digest("hex"),
                amzDate: date,
                region: "us-east-1",
                service: "bedrock",
                credentials: { accessKeyId: E2E_AWS_KEY_ID, secretAccessKey: E2E_AWS_SECRET },
              })
            );
          }),
      },
      {
        name: "the session token went upstream with the signature",
        ok: calls.every(
          (r) => r.headers["x-amz-security-token"] === E2E_AWS_SESSION_TOKEN
        ),
      },
      {
        name: "the signed payload hash is the hash of the body the upstream got",
        ok: calls.every(
          (r) =>
            r.headers["x-amz-content-sha256"] ===
            crypto.createHash("sha256").update(r.body).digest("hex")
        ),
      },
      {
        name: "the AWS secret and session token appear in no log file",
        ok: !logs.includes(E2E_AWS_SECRET) && !logs.includes(E2E_AWS_SESSION_TOKEN),
      },
    ];
  },
};

export const claudeCodeBedrockApiKey: Recipe = {
  name: "claude-code/bedrock-api-key",
  choice: { agent: "claude-code", provider: "bedrock-api-key" },
  install: claudeCode.install,
  proxyEnv: () => ({ AWS_REGION: "us-east-1" }),
  env: ({ key }) => ({ ...bedrockAgentEnv, AWS_BEARER_TOKEN_BEDROCK: key }),
  promptArgs: claudeCode.promptArgs,
  modelPath: BEDROCK_MODEL_PATH,
  extraChecks: ({ seen }) => {
    const calls = seen.filter((r) => BEDROCK_MODEL_PATH.test(r.url));
    return [
      {
        name: "the proxy signed nothing: the agent's own Bearer header went upstream",
        ok:
          calls.length > 0 &&
          calls.every(
            (r) =>
              r.headers.authorization === `Bearer ${DUMMY_KEY}` &&
              r.headers["x-amz-date"] === undefined
          ),
      },
    ];
  },
};
