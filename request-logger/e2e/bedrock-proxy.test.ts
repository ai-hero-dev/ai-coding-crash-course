import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freePort, startProxy, type StartedProxy } from "./driver";
import { startFakeUpstream, type FakeUpstream } from "./fake-upstream";

const BEDROCK = { agent: "claude-code", provider: "bedrock" };
const KEYS = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIDPROXYTEST",
  AWS_SECRET_ACCESS_KEY: "proxy-test-secret",
  AWS_SESSION_TOKEN: "",
};

let proxy: StartedProxy | undefined;
let upstream: FakeUpstream | undefined;
let denying: http.Server | undefined;
afterEach(async () => {
  proxy?.stop();
  await upstream?.close();
  denying?.close();
  proxy = upstream = denying = undefined;
});

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "request-logger-bedrock-proxy-"));

async function start(origin: string, env: Record<string, string>) {
  const port = await freePort();
  proxy = await startProxy({ stateDir: scratch(), upstream: origin, port, choice: BEDROCK, env });
  return port;
}

function send(
  port: number,
  options: {
    method?: string;
    host?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/model/m/invoke",
        headers: { host: options.host ?? `localhost:${port}`, ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end(options.body ?? (options.method && options.method !== "POST" ? undefined : "{}"));
  });
}

function fakeAwsCli(
  output: string,
  failure?: { stderr: string; exitCode: number }
): { env: Record<string, string>; runs: () => number } {
  const dir = scratch();
  const log = path.join(dir, "runs");
  fs.writeFileSync(log, "");
  const script = failure
    ? `#!/bin/sh\necho run >> "${log}"\necho '${failure.stderr}' >&2\nexit ${failure.exitCode}\n`
    : `#!/bin/sh\necho run >> "${log}"\nprintf '%s' '${output}'\n`;
  fs.writeFileSync(path.join(dir, "aws"), script, { mode: 0o755 });
  return {
    env: {
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    runs: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length,
  };
}

describe("Bedrock's signing route, through the real proxy", () => {
  it("signs and forwards a POST from an agent on this machine", async () => {
    upstream = await startFakeUpstream();
    const port = await start(upstream.origin, KEYS);
    expect((await send(port, {})).status).toBe(200);
    expect(String(upstream.seen[0]?.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDPROXYTEST\//
    );
  });

  it.each([
    ["a POST with an Origin", { headers: { origin: "https://evil.example" } }],
    ["a no-cors GET a page sent, with no Origin", { method: "GET", headers: { "sec-fetch-site": "cross-site" } }],
    ["a POST to another Bedrock API", { path: "/async-invoke" }],
  ])("refuses %s, and signs nothing", async (_name, options) => {
    upstream = await startFakeUpstream();
    const port = await start(upstream.origin, KEYS);
    expect((await send(port, options)).status).toBe(403);
    expect(upstream.seen).toEqual([]);
  });

  it("refuses Claude Code's GET /inference-profiles quietly, without the browser warning", async () => {
    upstream = await startFakeUpstream();
    const port = await start(upstream.origin, KEYS);
    let printed = "";
    proxy!.proxy.stdout!.on("data", (d) => (printed += d));
    proxy!.proxy.stderr!.on("data", (d) => (printed += d));
    expect((await send(port, { method: "GET", path: "/inference-profiles?type=SYSTEM_DEFINED" })).status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(printed).toContain("not a Bedrock model call, so not signed");
    expect(printed).not.toContain("only an agent on this machine");
    expect(upstream.seen).toEqual([]);
  });

  it("runs the AWS CLI once, not once per request, when every call comes back 403", async () => {
    denying = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end('{"message":"You don\'t have access to the model with the specified model ID."}');
      });
    });
    await new Promise<void>((resolve) => denying!.listen(0, "127.0.0.1", () => resolve()));
    const cli = fakeAwsCli(
      '{"Version":1,"AccessKeyId":"AKIDCLI","SecretAccessKey":"cli-secret","SessionToken":"cli-token","Expiration":"2099-01-01T00:00:00Z"}'
    );
    const port = await start(`http://127.0.0.1:${(denying.address() as AddressInfo).port}`, cli.env);
    for (let i = 0; i < 4; i++) expect((await send(port, {})).status).toBe(403);
    expect(cli.runs()).toBe(1);
  });

  it("answers 502 with the exit code, never the AWS CLI's stderr, when it fails", async () => {
    upstream = await startFakeUpstream();
    const cli = fakeAwsCli("", {
      stderr: "Error when retrieving credentials from custom-process: helper --token LEAKED-TOKEN",
      exitCode: 255,
    });
    const port = await start(upstream.origin, cli.env);
    let printed = "";
    proxy!.proxy.stderr!.on("data", (d) => (printed += d));
    const reply = await send(port, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reply.status).toBe(502);
    expect(reply.body).toContain("exited with code 255");
    expect(reply.body + printed).not.toContain("LEAKED");
    expect(upstream.seen).toEqual([]);
  });

});
