# ChatGPT plan in Cubby

Cubby's open-source deployment can connect an eligible ChatGPT account to power
its Workers OpenAI Responses calls. Settings lists the account's displayable
model catalog from `GET https://api.openai.com/v1/models`, preserving OpenAI's
ordering and `visibility: "list"` rule. It has no model selectors: structured
tasks and the purchase agent retain their existing Luna/Sol declarations.
An unavailable model or subscription restriction fails the call with OpenAI's
diagnostics; a connected account never silently falls back to paid API billing.

## Connect

1. Open Settings → ChatGPT plan → Continue with ChatGPT.
2. Create a Cubby HTTP API key in Account → API keys.
3. From a local checkout, run the command shown in Settings:

   ```sh
   pnpm chatgpt:connect --url https://cubby.example.com
   ```

4. Paste the Cubby key into the helper's hidden prompt, or supply it through
   `CUBBY_API_KEY` in your environment. The helper opens the system browser.
   Choose the ChatGPT account/workspace and allow plan usage.
5. Return to Settings and choose Check connection. Refresh models retrieves the
   live account catalog; Manage usage opens ChatGPT's usage controls.

The helper runs an HTTP callback on `127.0.0.1` with state, nonce, and PKCE.
It obtains the deployment's persistent, opaque host ID before authorization.
First registration uses `dynamic_agent_client`; later authorization reuses the
issued client ID. It securely sends the authorization code and original verifier
to Cubby's authenticated endpoint. Workers exchanges the code, verifies the
signed ID token's issuer, audience, expiration, nonce and the originally registered account identity, checks the granted
plan scope, and confirms model-catalog access before storing credentials.
No ChatGPT token is returned to the browser or saved by the helper.
The Mac can close after setup; Workers owns refreshes.

The shared household connection lives in the `CHATGPT_PLAN` SQLite Durable
Object named `household`. Its RPC surface returns account status, models and
inference responses, never access or refresh tokens. Concurrent refreshes are
serialized; the replacement access/refresh pair is persisted together before
use. No PostgreSQL schema change or new environment secret is required.

## Requests, errors, and disconnect

Subscription calls go directly to `https://api.openai.com/v1/responses`, using
the OAuth access token. They set `store: false` and `stream: true`, resend the
conversation input, convert system messages to developer messages, and supply
function/custom tools as developer `additional_tools` input. Unsupported preview
parameters are removed. Unsupported hosted tools fail before inference.
The existing application response cache still serves valid identical results.
Caller cancellation propagates to the inference owner through request IDs,
including after streaming starts. Calls have a five-minute maximum deadline;
a shorter configured gateway deadline wins.
Subscription usage records have zero separately billed API cost;
token counts remain visible. Embeddings, Workers AI and Anthropic keep their
existing transport and billing.

OpenAI eligibility, region, revoked-session and usage-limit errors are surfaced
with credential-shaped values scrubbed. Temporary refresh errors preserve credentials. Terminal refresh errors clear
unusable tokens and show Reconnect ChatGPT; the deployment remains on subscription
routing until explicitly disconnected. Reauthorize with the helper using the
original account. Disconnect ChatGPT revokes the renewable session before deleting
local tokens; the issued client ID and verified account identity remain registered. A failed revocation keeps the connection so it can be retried;
access can also be revoked in ChatGPT Settings. An explicitly disconnected
deployment resumes its existing paid AI Gateway route.

## Availability and verification

OpenAI documents remotely running open-source tools on self-hosted VMs, while
its overview separately directs remotely hosted apps to an interest form.
Workers is not explicitly covered. This integration uses the documented OAuth
and public Responses route; it does not establish OpenAI approval for every
hosting arrangement or account. A successful live connection and completed
inference must be verified for the intended deployment before claiming it works.

Automated checks use synthetic external account responses. They verify token
rotation and persistence, request shaping, and settings behavior; they do not
prove live subscription eligibility. Live setup requires a person to consent.
Keep credentials and account data out of screenshots, artifacts and logs.

Primary references:

- [Overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
