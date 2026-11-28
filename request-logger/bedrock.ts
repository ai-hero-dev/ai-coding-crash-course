import crypto from "node:crypto";
import { execFile } from "node:child_process";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAtMs?: number;
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

export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function canonicalUri(pathname: string): string {
  return pathname ? pathname.split("/").map(uriEncode).join("/") : "/";
}

const decodeQueryPart = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export function canonicalQuery(query: string): string {
  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf("=");
      return at === -1 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
    })
    .map(([k, v]) => [uriEncode(decodeQueryPart(k)), uriEncode(decodeQueryPart(v))] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request"
  );
}

export function authorizationFor(input: {
  method: string;
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
}): string {
  const queryAt = input.path.indexOf("?");
  const pathname = queryAt === -1 ? input.path : input.path.slice(0, queryAt);
  const query = queryAt === -1 ? "" : input.path.slice(queryAt + 1);

  const names = Object.keys(input.headers).sort();
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(pathname),
    canonicalQuery(query),
    names.map((n) => `${n}:${input.headers[n].trim()}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac(
      "sha256",
      signingKey(
        input.credentials.secretAccessKey,
        dateStamp,
        input.region,
        input.service
      )
    )
    .update(stringToSign)
    .digest("hex");

  return (
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

export function signRequest(input: SignInput): Record<string, string> {
  const amzDate = (input.now ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const payloadHash = sha256Hex(input.body);

  const added: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.credentials.sessionToken) {
    added["x-amz-security-token"] = input.credentials.sessionToken;
  }

  return {
    ...added,
    authorization: authorizationFor({
      method: input.method,
      path: input.path,
      headers: { host: input.hostname, ...added },
      payloadHash,
      amzDate,
      region: input.region,
      service: input.service,
      credentials: input.credentials,
    }),
  };
}

const EXPIRY_MARGIN_MS = 2 * 60_000;
const UNDATED_TTL_MS = 5 * 60_000;
const RELOAD_FLOOR_MS = 30_000;

type Exec = (env: NodeJS.ProcessEnv) => Promise<string>;

const runAwsCli: Exec = (env) =>
  new Promise((resolve, reject) => {
    execFile(
      "aws",
      ["configure", "export-credentials", "--format", "process"],
      { env, timeout: 30_000 },
      (err, stdout, stderr) =>
        err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });

export function createCredentialProvider(
  env: NodeJS.ProcessEnv,
  exec: Exec = runAwsCli,
  clock: () => number = Date.now
) {
  let cached: { creds: AwsCredentials; validUntil: number; loadedAt: number } | null =
    null;
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
        `could not load AWS credentials${profile} with "aws configure ` +
          `export-credentials": ${(err as Error).message}. If your SSO session ` +
          `expired, run "aws sso login" and retry.`
      );
    }
    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(
        'the AWS CLI printed something that is not JSON for "aws configure export-credentials --format process"'
      );
    }
    if (!parsed?.AccessKeyId || !parsed?.SecretAccessKey) {
      throw new Error("the AWS CLI returned no access key");
    }
    return {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      sessionToken: parsed.SessionToken || undefined,
      expiresAtMs: parsed.Expiration ? Date.parse(parsed.Expiration) : undefined,
    };
  }

  return {
    async get(): Promise<AwsCredentials> {
      if (cached && clock() < cached.validUntil) return cached.creds;
      inflight ??= load()
        .then((creds) => {
          cached = {
            creds,
            validUntil: creds.expiresAtMs
              ? creds.expiresAtMs - EXPIRY_MARGIN_MS
              : clock() + UNDATED_TTL_MS,
            loadedAt: clock(),
          };
          return creds;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    invalidate(rejected: AwsCredentials): void {
      if (cached?.creds !== rejected) return;
      if (clock() - cached.loadedAt < RELOAD_FLOOR_MS) return;
      cached = null;
    },
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// zlib.crc32 needs Node 22.2.
export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

const HEADER_VALUE_BYTES_BY_TYPE: Record<number, number> = {
  0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16,
};

function readHeaders(buf: Buffer): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  let at = 0;
  while (at < buf.length) {
    const nameLength = buf[at];
    if (at + 2 + nameLength > buf.length) return undefined;
    const name = buf.toString("utf8", at + 1, at + 1 + nameLength);
    const type = buf[at + 1 + nameLength];
    at += 2 + nameLength;
    if (type === 6 || type === 7) {
      if (at + 2 > buf.length) return undefined;
      const length = buf.readUInt16BE(at);
      if (type === 7) headers[name] = buf.toString("utf8", at + 2, at + 2 + length);
      at += 2 + length;
    } else if (type in HEADER_VALUE_BYTES_BY_TYPE) {
      at += HEADER_VALUE_BYTES_BY_TYPE[type];
    } else {
      return undefined;
    }
  }
  return at === buf.length ? headers : undefined;
}

export function parseEventStream(
  buf: Buffer
):
  | { messages: EventStreamMessage[]; stopped: "cut-off" | "corrupt" | null }
  | undefined {
  const messages: EventStreamMessage[] = [];
  let at = 0;
  let stopped: "cut-off" | "corrupt" | null = null;
  while (at < buf.length) {
    if (at + 16 > buf.length) {
      stopped = "cut-off";
      break;
    }
    const total = buf.readUInt32BE(at);
    const headersLength = buf.readUInt32BE(at + 4);
    if (
      buf.readUInt32BE(at + 8) !== crc32(buf.subarray(at, at + 8)) ||
      total < 16 + headersLength
    ) {
      stopped = "corrupt";
      break;
    }
    if (at + total > buf.length) {
      stopped = "cut-off";
      break;
    }
    const end = at + total;
    const headers =
      buf.readUInt32BE(end - 4) === crc32(buf.subarray(at, end - 4))
        ? readHeaders(buf.subarray(at + 12, at + 12 + headersLength))
        : undefined;
    if (!headers) {
      stopped = "corrupt";
      break;
    }
    messages.push({
      headers,
      payload: buf.subarray(at + 12 + headersLength, end - 4),
    });
    at = end;
  }
  if (messages.length === 0) return undefined;
  return { messages, stopped };
}

export function decodeBedrockStream(
  raw: Buffer
): { sse: string; errors: string[] } | undefined {
  const parsed = parseEventStream(raw);
  if (!parsed) return undefined;
  const events: string[] = [];
  const errors: string[] = [];
  for (const { headers, payload } of parsed.messages) {
    const text = payload.toString("utf8");
    const messageType = headers[":message-type"];
    if (messageType === "event" && headers[":event-type"] === "chunk") {
      try {
        const json = Buffer.from(JSON.parse(text).bytes, "base64").toString("utf8");
        events.push(`event: ${JSON.parse(json).type}\ndata: ${json}\n`);
      } catch {
        errors.push(`a chunk that is not JSON: ${text.slice(0, 200)}`);
      }
    } else if (messageType === "exception") {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      errors.push(`${headers[":exception-type"] ?? "exception"}: ${message}`);
    } else if (messageType === "error") {
      errors.push(
        `${headers[":error-code"] ?? "error"}: ${headers[":error-message"] ?? text}`
      );
    }
  }
  if (parsed.stopped === "cut-off") {
    errors.push("the stream ended part-way through a message");
  } else if (parsed.stopped === "corrupt") {
    errors.push("a message failed its CRC or header check, so the rest of the stream was not decoded");
  }
  return { sse: events.join("\n"), errors };
}
