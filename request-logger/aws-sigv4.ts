/**
 * AWS Signature Version 4, by hand.
 *
 * This exists because a plain forwarding proxy cannot relay a signed AWS
 * request. SigV4 signs the Host header, among others, so the moment this tool
 * rewrites `Host: localhost:8787` to `Host: bedrock-runtime.us-east-1.amazonaws.com`
 * the signature the agent computed no longer matches what Bedrock recomputes,
 * and every request comes back 403 SignatureDoesNotMatch. The agent's signature
 * therefore cannot be forwarded — it has to be thrown away and replaced with one
 * this tool computes itself, against the host the request is really going to.
 *
 * Signing needs the secret access key, which the agent's signature does not
 * carry, so the credentials are read separately — see loadCredentials.
 *
 * Written against Node's crypto rather than @aws-sdk/signature-v4 to keep this
 * tool's "zero runtime dependencies" promise (see proxy.ts). The canonical-path
 * and canonical-query rules below are the fiddly part, and they are deliberately
 * a transcription of what @smithy/signature-v4 does, because Bedrock recomputes
 * the signature the same way for every AWS client. Getting either wrong produces
 * a 403 whose message never says which rule was broken.
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Set for temporary credentials (SSO, assumed roles); absent for long-lived keys. */
  sessionToken?: string;
  /** Epoch milliseconds, or null when the credentials do not expire. */
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Injected in tests so no real `aws` binary, profile or SSO session is needed. */
export type CommandRunner = (file: string, args: string[]) => string;

const defaultRunner: CommandRunner = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Read credentials from the AWS CLI rather than resolving them here.
 *
 * `aws configure export-credentials` is the CLI's own supported way to hand its
 * resolved credentials to another program, and it resolves the whole chain —
 * static keys, environment variables, an SSO session's cached token, an assumed
 * role — including refreshing an SSO token that is still valid. Reimplementing
 * any of that against ~/.aws/sso/cache would be a large amount of code that
 * silently rots whenever the CLI changes, so this shells out instead. It is also
 * why this stays dependency-free: a student set up for Bedrock already has the
 * `aws` CLI, since that is how they logged in.
 */
export function loadCredentials(
  options: { profile?: string; runner?: CommandRunner } = {}
): AwsCredentials {
  const runner = options.runner ?? defaultRunner;
  const args = ["configure", "export-credentials", "--format", "process"];
  if (options.profile) args.push("--profile", options.profile);

  let raw: string;
  try {
    raw = runner("aws", args);
  } catch (err) {
    throw new Error(
      `could not read AWS credentials via \`aws ${args.join(" ")}\`: ` +
        `${(err as Error).message.trim()}\n\n${credentialAdvice(options.profile)}`
    );
  }

  return parseExportedCredentials(raw);
}

/**
 * What to actually do about a failed credential read, which depends entirely on
 * whether a profile was named.
 *
 * With no profile, the overwhelmingly likely cause is that AWS_PROFILE is not
 * set in *this* shell. That trips up exactly the setup this provider exists for:
 * Claude Code reads AWS_PROFILE from the `env` block of ~/.claude/settings.json,
 * which it applies to itself, so a student can have Bedrock working perfectly in
 * their agent and still have a terminal that has never heard of their profile.
 * Suggesting `aws sso login` there sends them to log in to a session that is
 * already valid, which is the least useful advice available.
 */
function credentialAdvice(profile?: string): string {
  if (profile) {
    return (
      `The profile "${profile}" was found but has no usable credentials. If its SSO ` +
      `session has expired, run \`aws sso login --profile ${profile}\`.`
    );
  }
  return (
    "No AWS profile was named, so the default profile was used. Set AWS_PROFILE in " +
    "the shell you start this tool from:\n\n" +
    "      AWS_PROFILE=your-profile npm run request-logger\n\n" +
    "  Note that a profile set in the `env` block of ~/.claude/settings.json does " +
    "not count: Claude Code applies that to itself, not to this shell. " +
    "`aws configure list-profiles` lists what you have."
  );
}

/**
 * Parse the `--format process` payload: a JSON object with capitalised keys,
 * documented as the credential-process contract rather than as this command's
 * own output shape, which is why the field names look unlike the rest of this
 * file.
 */
export function parseExportedCredentials(raw: string): AwsCredentials {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "AWS credential output was not JSON. Expected the object that " +
        "`aws configure export-credentials --format process` prints."
    );
  }

  const accessKeyId = parsed?.AccessKeyId;
  const secretAccessKey = parsed?.SecretAccessKey;
  if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string") {
    throw new Error(
      "AWS credential output had no AccessKeyId/SecretAccessKey. Check that the " +
        "profile is configured and its SSO session is still valid."
    );
  }

  // Expiration is absent for long-lived keys. An unparseable one is treated the
  // same way, so a surprising value means "re-read sooner" rather than "cache
  // these forever".
  const expiration = typeof parsed.Expiration === "string" ? Date.parse(parsed.Expiration) : NaN;

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken:
      typeof parsed.SessionToken === "string" && parsed.SessionToken.length > 0
        ? parsed.SessionToken
        : undefined,
    expiresAt: Number.isNaN(expiration) ? null : expiration,
  };
}

/**
 * Re-read credentials only when the cached ones are close to expiring.
 *
 * Shelling out to the CLI takes the better part of a second, and this sits in
 * the request path, so doing it per request would add that to every single
 * model call. The margin is generous because an expiry that lands mid-request
 * costs a failed model call, while re-reading a few minutes early costs one
 * subprocess an hour.
 */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function credentialsAreFresh(
  credentials: AwsCredentials | null,
  now: number
): credentials is AwsCredentials {
  if (!credentials) return false;
  if (credentials.expiresAt === null) return true;
  return credentials.expiresAt - now > REFRESH_MARGIN_MS;
}

/**
 * A caching credential reader. One per process, built at startup so an expired
 * SSO session is reported before the student's agent sends its first request
 * rather than as a 403 buried in a log file.
 */
export function createCredentialCache(options: {
  profile?: string;
  runner?: CommandRunner;
  now?: () => number;
}): () => AwsCredentials {
  const now = options.now ?? Date.now;
  let cached: AwsCredentials | null = null;
  return () => {
    if (credentialsAreFresh(cached, now())) return cached;
    cached = loadCredentials(options);
    return cached;
  };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function sha256Hex(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * encodeURIComponent, plus the characters RFC 3986 reserves that it leaves
 * alone. AWS requires all of `!'()*` percent-encoded; JavaScript does not
 * encode them, so a path or query value containing one would otherwise sign
 * differently here than it does on the AWS side.
 */
export function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The canonical URI: the request path, normalised, then percent-encoded a
 * second time.
 *
 * The second encoding is not a mistake and not a no-op. SigV4 requires it for
 * every service except S3, and it is what makes a Bedrock model ID containing a
 * colon work: `.../claude-sonnet-4-5-20250929-v1:0/invoke` arrives here with the
 * colon already literal or already `%3A`, and either way this encodes it once
 * more so the canonical form matches what Bedrock computes from the bytes it
 * received. Slashes are restored afterwards, since they separate segments
 * rather than being data.
 */
export function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalised =
    (path.startsWith("/") ? "/" : "") +
    segments.join("/") +
    (segments.length > 0 && path.endsWith("/") ? "/" : "");
  return escapeUri(normalised).replace(/%2F/g, "/");
}

/**
 * The canonical query string: every parameter re-encoded and sorted by name,
 * then by value. Bedrock's invoke endpoints carry no query string, so in
 * practice this returns "" — it is here because the signature covers the query
 * whether or not there is one, and because a future provider entry pointed at a
 * different AWS service will have one.
 */
export function canonicalQuery(search: string): string {
  if (search.length === 0) return "";
  const pairs: Array<[string, string]> = [];
  for (const part of search.split("&")) {
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    // Decoded first so an already-encoded value is not encoded twice: unlike
    // the path, the query is encoded exactly once in the canonical form.
    pairs.push([escapeUri(safeDecode(rawKey)), escapeUri(safeDecode(rawValue))]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A malformed percent-escape must not throw here — sign it as it arrived. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 2026-09-13T17:58:20.542Z -> 20260913T175820Z */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
}

/**
 * The canonical request: the exact bytes AWS rebuilds on its side and hashes.
 *
 * Split out from signRequest, rather than inlined, so the three steps of the
 * algorithm can each be tested against AWS's own published vectors. signRequest
 * always signs a `x-amz-content-sha256` header, and the vectors do not, so a
 * test that could only go through signRequest could never reproduce one.
 *
 * `signedHeaders` is taken already lower-cased, since its keys go into the
 * signature both as the canonical header block and as the SignedHeaders list.
 */
export function buildCanonicalRequest(input: {
  method: string;
  /** The path as it will be sent upstream, query string included. */
  path: string;
  signedHeaders: Record<string, string>;
  payloadHash: string;
}): string {
  const questionMark = input.path.indexOf("?");
  const pathOnly = questionMark === -1 ? input.path : input.path.slice(0, questionMark);
  const search = questionMark === -1 ? "" : input.path.slice(questionMark + 1);

  const names = Object.keys(input.signedHeaders).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${input.signedHeaders[name].trim().replace(/\s+/g, " ")}\n`)
    .join("");

  return [
    input.method.toUpperCase(),
    canonicalPath(pathOnly),
    canonicalQuery(search),
    canonicalHeaders,
    names.join(";"),
    input.payloadHash,
  ].join("\n");
}

export function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

export function buildStringToSign(input: {
  stamp: string;
  scope: string;
  canonicalRequest: string;
}): string {
  return [ALGORITHM, input.stamp, input.scope, sha256Hex(input.canonicalRequest)].join("\n");
}

/** The four-step signing key derivation, then the signature over the string to sign. */
export function calculateSignature(input: {
  secretAccessKey: string;
  dateStamp: string;
  region: string;
  service: string;
  stringToSign: string;
}): string {
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, input.dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, input.service);
  const signingKey = hmac(serviceKey, "aws4_request");
  return crypto
    .createHmac("sha256", signingKey)
    .update(input.stringToSign, "utf8")
    .digest("hex");
}

export interface SignRequestInput {
  method: string;
  /** The path as it will be sent upstream, query string included. */
  path: string;
  /** The host the request is really going to — not the host the agent addressed. */
  hostname: string;
  region: string;
  /** The AWS service name in the credential scope, e.g. "bedrock". */
  service: string;
  body: Buffer;
  credentials: AwsCredentials;
  /**
   * Extra headers to bring inside the signature, lower-cased. Keep this small:
   * a signed header must reach AWS byte-identical, so anything a proxy or the
   * runtime might rewrite is safer left unsigned. Unsigned headers are still
   * sent and still honoured; they just are not covered by the signature.
   */
  extraSignedHeaders?: Record<string, string>;
  /** Injected in tests so a signature can be asserted against a fixed vector. */
  now?: Date;
}

/**
 * Sign a request, returning every header that must replace the agent's own.
 *
 * The caller is responsible for dropping the agent's `authorization` and its
 * stale `x-amz-*` headers before applying these — see applySigning in proxy.ts.
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const now = input.now ?? new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const signed: Record<string, string> = {
    host: input.hostname,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  if (input.credentials.sessionToken) {
    signed["x-amz-security-token"] = input.credentials.sessionToken;
  }
  for (const [name, value] of Object.entries(input.extraSignedHeaders ?? {})) {
    signed[name.toLowerCase()] = value;
  }

  const signedHeaders = Object.keys(signed).sort().join(";");
  const scope = credentialScope(dateStamp, input.region, input.service);
  const signature = calculateSignature({
    secretAccessKey: input.credentials.secretAccessKey,
    dateStamp,
    region: input.region,
    service: input.service,
    stringToSign: buildStringToSign({
      stamp,
      scope,
      canonicalRequest: buildCanonicalRequest({
        method: input.method,
        path: input.path,
        signedHeaders: signed,
        payloadHash,
      }),
    }),
  });

  return {
    ...signed,
    authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
