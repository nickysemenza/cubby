import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { z } from "zod";

import type { ChatGptAuthorization } from "../apps/web/src/lib/chatgpt-plan.ts";

import { encodeBase64Url } from "../packages/shared/src/base64.ts";

const { values } = parseArgs({
  options: { url: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  process.stdout.write(
    "Usage: pnpm chatgpt:connect --url https://cubby.example.com\nUses CUBBY_API_KEY or securely prompts for a Cubby HTTP API key.\n",
  );
  process.exit(0);
}
if (!values.url)
  throw new Error("Supply --url for the Cubby deployment to connect");
const base = new URL(values.url);
if (
  base.protocol !== "https:" &&
  !(
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(base.hostname)
  )
) {
  throw new Error("Cubby must use HTTPS, except a local development server");
}
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/"
)
  throw new Error("Supply only the Cubby origin");

async function promptKey() {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const input = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    const answer = input.question("Cubby API key (hidden): ");
    muted = true;
    return (await answer).trim();
  } finally {
    input.close();
    process.stdout.write("\n");
  }
}

const apiKey = process.env.CUBBY_API_KEY ?? (await promptKey());
if (!apiKey) throw new Error("A Cubby API key is required");
async function cubby(path: string, body?: ChatGptAuthorization) {
  const options: RequestInit = {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(
    new URL(`/api/ai/chatgpt${path}`, base),
    options,
  );
  if (!response.ok)
    throw new Error(`Cubby HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

const host = z
  .object({ hostId: z.string(), clientId: z.string().nullable() })
  .parse(await cubby("?authorization"));
const random = () =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const state = random();
const nonce = random();
const verifier = random();
const challenge = encodeBase64Url(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ),
);
const callback = Promise.withResolvers<{ code: string; clientId: string }>();
let consumed = false;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/auth/callback" || request.method !== "GET") {
    response.writeHead(404).end();
    return;
  }
  if (consumed || url.searchParams.get("state") !== state) {
    response.writeHead(400).end("Invalid sign-in state");
    return;
  }
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id") ?? host.clientId;
  const error = url.searchParams.get("error");
  consumed = true;
  if (
    error ||
    !code ||
    !clientId ||
    (host.clientId && clientId !== host.clientId)
  ) {
    response
      .writeHead(400)
      .end("ChatGPT authorization was not completed. Return to your terminal.");
    callback.reject(
      new Error(
        "ChatGPT authorization was denied or returned an invalid registration",
      ),
    );
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    })
    .end(
      "ChatGPT authorization received. Return to your terminal to finish connecting Cubby.",
    );
  callback.resolve({ code, clientId });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = z
  .object({ port: z.number().int().positive() })
  .parse(server.address());
const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
const parameters = new URLSearchParams({
  client_id: host.clientId ?? "dynamic_agent_client",
  ext_agent_host_id: host.hostId,
  response_type: "code",
  redirect_uri: redirectUri,
  scope:
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  resource: "https://api.openai.com/v1",
  state,
  nonce,
  code_challenge_method: "S256",
  code_challenge: challenge,
});
if (!host.clientId) parameters.set("agent_name_hint", "Cubby");
authorize.search = parameters.toString();
const timer = setTimeout(
  () =>
    callback.reject(new Error("ChatGPT sign-in timed out after 10 minutes")),
  600_000,
);
try {
  process.stdout.write(
    "Opening ChatGPT sign-in. Approve Cubby’s use of your ChatGPT plan.\n",
  );
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  execFile(command, [authorize.href], (error) => {
    if (error) callback.reject(new Error("Could not open the system browser"));
  });
  const result = await callback.promise;
  await cubby("", { ...result, verifier, nonce, redirectUri });
  process.stdout.write(
    "Cubby is connected. Refresh Settings to see your available models. Workers now owns token refresh; no local credentials were saved.\n",
  );
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
