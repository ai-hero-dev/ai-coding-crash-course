# AWS Bedrock support (proposal)

Adds an "AWS Bedrock" provider for Claude Code to request-logger, so students
running Claude Code through Bedrock can capture requests the same way every
other provider already does.

## What it adds

- **New catalogue entry** (`agents.ts`): `claude-code` / `bedrock`, host
  `bedrock-runtime.{region}.amazonaws.com`. Region comes from `AWS_REGION` /
  `AWS_DEFAULT_REGION` in the shell running the tool, defaulting to
  `us-east-1`.
- **`aws-sigv4.ts`** (new): a from-scratch AWS SigV4 signer, and a credential
  reader that shells out to `aws configure export-credentials` (no AWS SDK
  dependency, matching this tool's zero-dependency promise).
  - Bedrock's signature covers the `Host` header. The proxy's whole job is
    rewriting `Host`, so the agent's own signature stops matching the moment
    it forwards a request. This tool strips that signature and signs a fresh
    one against the real Bedrock host.
  - The credential reader caches credentials and refreshes them a few
    minutes before expiry, so a live SSO session doesn't shell out on every
    request.
  - This tool catches an expired SSO session once at startup, with a clear
    message and `aws sso login` instructions, instead of letting it surface
    later as a confusing upstream 403.
- **`bedrock.ts`** (new): decodes Bedrock's binary `vnd.amazon.eventstream`
  streaming format into the same SSE text every other Anthropic-shaped
  response uses, so the existing renderer reads a Bedrock capture unchanged.
  It decodes only the copy written to the log; the bytes forwarded to the
  agent stay untouched.
- **`proxy.ts`**: re-signs a request when the resolved target requires it
  (`applySigning`), drops the agent's now-stale `x-amz-*` headers, decodes an
  event-stream response before writing the capture, and reports the signing
  profile/region in the startup banner.
- **`render.ts`**: reads the model ID out of Bedrock's
  `/model/{id}/invoke[-with-response-stream]` path (Bedrock has no `model`
  field in the body), and redacts `x-amz-security-token` the same way
  `authorization` is already redacted.

## What it does not touch

This diff forwards every other provider's request with its original
credentials, untouched. Bedrock is the one exception, confined to a single
`signing` field on `ResolvedTarget`: one catalogue entry sets it, and one
check in `proxy.ts` reads it.

## How it was tested

`aws-sigv4.test.ts` and `bedrock.test.ts` are new; the existing
`agents.test.ts` and `proxy.test.ts` gained cases for the new wiring. All 359
request-logger tests pass. I checked signing against AWS's own published
SigV4 test vectors, and ran end-to-end streaming against a real Bedrock
endpoint under `AWS_PROFILE=claude-code-bedrock`.

## Known gaps

- Region and profile come from the shell running request-logger, not the
  shell running Claude Code. Claude Code applies `AWS_REGION`/`AWS_PROFILE`
  from `~/.claude/settings.json`'s `env` block to itself, so the two shells
  can disagree without either side raising an error. The provider's
  `notes`/`warnings` in `agents.ts` call this out, but nothing guards
  against it.
- This needs the `aws` CLI installed and configured. There's no fallback
  credential path.
- I haven't run this through a full course lesson end to end, the way the
  direct Anthropic route and OMP have been.
