/** AWS SigV4 for Bedrock. Claude Code's own signature would cover Host: localhost. */

import crypto from "node:crypto";
import { execFile } from "node:child_process";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
}

export interface SignInput {
  method: string;
  hostname: string;
  path: string;
  body: Buffer;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now?: Date;
}

const sha256Hex = (data: string | Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) =>
  crypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986: everything but A-Z a-z 0-9 - _ . ~ */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Non-S3 services encode each path segment again on top of how it was sent. */
export function canonicalUri(pathname: string): string {
  if (!pathname) return "/";
  return pathname.split("/").map(uriEncode).join("/");
}

function canonicalQuery(search: string): string {
  if (!search) return "";
  const params = new URLSearchParams(search);
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function signRequest(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const queryAt = input.path.indexOf("?");
  const pathname = queryAt === -1 ? input.path : input.path.slice(0, queryAt);
  const search = queryAt === -1 ? "" : input.path.slice(queryAt + 1);

  const headers: Record<string, string> = {
    host: input.hostname,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(pathname),
    canonicalQuery(search),
    names.map((n) => `${n}:${headers[n].trim()}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  const { host: _host, ...rest } = headers;
  return {
    ...rest,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const EXPIRY_MARGIN_MS = 2 * 60_000;
const UNDATED_TTL_MS = 5 * 60_000;

type Exec = (env: NodeJS.ProcessEnv) => Promise<string>;

const runAwsCli: Exec = (env) =>
  new Promise((resolve, reject) => {
    execFile(
      "aws",
      ["configure", "export-credentials", "--format", "process"],
      { env, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new Error(detail));
        } else resolve(stdout);
      }
    );
  });

/** Env keys, else `aws configure export-credentials` (honours AWS_PROFILE). Cached until expiry. */
export function createCredentialProvider(
  env: NodeJS.ProcessEnv,
  exec: Exec = runAwsCli,
  clock: () => number = Date.now
) {
  let cached: { creds: AwsCredentials; validUntil: number } | null = null;
  let inflight: Promise<AwsCredentials> | null = null;

  async function load(): Promise<AwsCredentials> {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN || undefined,
      };
    }
    let stdout: string;
    try {
      stdout = await exec(env);
    } catch (err) {
      const profile = env.AWS_PROFILE ? ` for profile "${env.AWS_PROFILE}"` : "";
      throw new Error(
        `could not load AWS credentials${profile} with the AWS CLI ` +
          `(aws configure export-credentials): ${(err as Error).message}. ` +
          `Refresh your credentials, then retry.`
      );
    }
    const parsed = JSON.parse(stdout);
    if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
      throw new Error("the AWS CLI returned no access key");
    }
    return {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      sessionToken: parsed.SessionToken || undefined,
      expiresAt: parsed.Expiration ? Date.parse(parsed.Expiration) : undefined,
    };
  }

  return {
    async get(): Promise<AwsCredentials> {
      if (cached && clock() < cached.validUntil) return cached.creds;
      inflight ??= load()
        .then((creds) => {
          const now = clock();
          cached = {
            creds,
            validUntil: creds.expiresAt
              ? creds.expiresAt - EXPIRY_MARGIN_MS
              : now + UNDATED_TTL_MS,
          };
          return creds;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
