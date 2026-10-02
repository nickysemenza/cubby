import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  browserCapture,
  importExtractionModelOutput,
  orderMailMessageClassification,
} from "@cubby/schemas/purchase-import";
import { GMAIL_READONLY_SCOPE } from "../src/lib/google-auth-constants";

const configuration = z.object({
  email: z.email(),
  message: z.json(),
  classification: orderMailMessageClassification,
  extraction: z
    .object({ url: z.url(), output: importExtractionModelOutput })
    .optional(),
});
type ProviderJson = z.infer<typeof configuration>["message"];
const sendJson = (
  response: ServerResponse,
  status: number,
  value: ProviderJson,
) =>
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
const messageIdentity = z.object({
  id: z.string(),
  payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
  }),
});

/** Synthetic external OAuth/Gmail/model provider; never seeds a Cubby Account, Run or Purchase. */
export async function createLocalGoogleProvider() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = {
    ...z
      .object({ kty: z.literal("RSA"), n: z.string(), e: z.string() })
      .parse(publicKey.export({ format: "jwk" })),
    kid: "synthetic-key",
    alg: "RS256",
  };
  let fixture: z.infer<typeof configuration> | undefined;
  const codes = new Map<
    string,
    { challenge: string; redirect: string; state: string; scope: string }
  >();
  const events: string[] = [];
  let origin = "";
  const json = (value: ProviderJson) => JSON.stringify(value);
  const encode = (value: ProviderJson) =>
    Buffer.from(json(value)).toString("base64url");
  const consent = (url: URL, response: ServerResponse) => {
    const send = (status: number, value: ProviderJson) =>
      sendJson(response, status, value);
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    const target = new URL(redirect);
    if (
      target.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.pathname !== "/api/auth/callback/google"
    ) {
      send(400, { message: "Invalid synthetic callback" });
      return;
    }
    const code = randomUUID();
    const challenge = url.searchParams.get("code_challenge") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const scope = url.searchParams.get("scope") ?? "";
    if (
      !challenge ||
      !state ||
      !scope.split(" ").includes(GMAIL_READONLY_SCOPE)
    ) {
      send(400, { message: "Missing PKCE, state or read-only grant" });
      return;
    }
    codes.set(code, { challenge, redirect, state, scope });
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<main><h1>Synthetic Google consent</h1><p>Grant read-only Gmail access to Cubby.</p><form action="/approve"><input type="hidden" name="code" value="${code}"><button>Grant read-only Gmail access</button></form></main>`,
      );
    return;
  };
  const exchange = (body: string, response: ServerResponse) => {
    const send = (status: number, value: ProviderJson) =>
      sendJson(response, status, value);
    const fields = new URLSearchParams(body);
    const code = fields.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code);
    if (
      !grant ||
      fields.get("redirect_uri") !== grant.redirect ||
      createHash("sha256")
        .update(fields.get("code_verifier") ?? "")
        .digest("base64url") !== grant.challenge
    ) {
      send(400, { message: "Synthetic code or PKCE mismatch" });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", kid: key.kid })}.${encode({ iss: origin, aud: "synthetic-google-client", sub: "synthetic-google-user", email: configuration.parse(fixture).email, email_verified: true, name: "Synthetic reviewer", iat: now, exp: now + 3600 })}`;
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(unsigned),
      privateKey,
    ).toString("base64url");
    send(200, {
      access_token: "synthetic-mail-access",
      refresh_token: "synthetic-mail-refresh",
      id_token: `${unsigned}.${signature}`,
      expires_in: 3600,
      scope: grant.scope,
    });
    return;
  };
  const extract = (body: string, response: ServerResponse) => {
    const send = (status: number, value: ProviderJson) =>
      sendJson(response, status, value);
    const capture = browserCapture.parse(JSON.parse(body));
    const extraction = configuration.parse(fixture).extraction;
    if (
      !extraction ||
      capture.url !== extraction.url ||
      !extraction.output.candidate ||
      !capture.text.includes(
        extraction.output.candidate.lines[0]?.title ?? "",
      ) ||
      !capture.text.includes("42.50")
    ) {
      send(400, {
        message:
          "Extraction did not receive the configured captured retailer evidence",
      });
      return;
    }
    send(200, extraction.output);
    return;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      events.push(`${request.method} ${url.pathname}`);
      const send = (status: number, value: ProviderJson) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(json(value));
      if (url.pathname === "/jwks") {
        send(200, { keys: [key] });
        return;
      }
      if (!fixture) {
        send(503, { message: "Synthetic Google provider not configured" });
        return;
      }
      if (url.pathname === "/authorize") {
        consent(url, response);
        return;
      }
      if (url.pathname === "/approve") {
        const code = url.searchParams.get("code") ?? "";
        const grant = codes.get(code);
        if (!grant) {
          send(400, { message: "Unknown synthetic consent" });
          return;
        }
        const callback = new URL(grant.redirect);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", grant.state);
        response.writeHead(302, { location: callback.href }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname === "/token") {
        exchange(body, response);
        return;
      }
      if (url.pathname === "/model/classify-mail") {
        const evidence = z
          .object({ subject: z.string(), content: z.json() })
          .parse(JSON.parse(body));
        const identity = messageIdentity.parse(fixture.message);
        const subject = identity.payload.headers.find(
          (header) => header.name.toLowerCase() === "subject",
        )?.value;
        if (evidence.subject !== subject) {
          send(400, {
            message: "Classifier did not receive the configured mail evidence",
          });
          return;
        }
        send(200, fixture.classification);
        return;
      }
      if (url.pathname === "/model/extract-capture") {
        extract(body, response);
        return;
      }
      if (
        url.pathname.startsWith("/gmail/v1/") &&
        request.headers.authorization !== "Bearer synthetic-mail-access"
      ) {
        send(401, { message: "Missing exchanged Gmail token" });
        return;
      }
      const message = messageIdentity.parse(fixture.message);
      if (url.pathname === "/gmail/v1/users/me/messages") {
        send(200, { messages: [{ id: message.id }], resultSizeEstimate: 1 });
        return;
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${message.id}`) {
        send(200, fixture.message);
        return;
      }
      send(404, { message: "Unknown synthetic provider endpoint" });
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(
        json({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
  return {
    url: origin,
    configure(input: z.input<typeof configuration>) {
      fixture = configuration.parse(input);
      events.length = 0;
    },
    events: () => [...events],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
export type LocalGoogleProvider = Awaited<
  ReturnType<typeof createLocalGoogleProvider>
>;
