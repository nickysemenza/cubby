import {
  chatGptAuthorization,
  chatGptModels,
  type ChatGptAuthorization,
  type ChatGptStatus,
} from "@cubby/schemas/chatgpt";
import type { gatewayQuery } from "@cubby/shared/ai-gateway-request";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { chatGptRequest } from "./transport";

const AUTH = "https://auth.openai.com";
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
const API = "https://api.openai.com/v1";
const jwks = createRemoteJWKSet(new URL(`${AUTH}/.well-known/jwks.json`));
const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.literal("Bearer"),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
const connection = z.object({
  clientId: z.string(),
  subject: z.string(),
  email: z.string().nullable(),
  connected: z.boolean().default(true),
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number(),
});
export type ChatGptConnection = z.infer<typeof connection>;
type Connection = ChatGptConnection;
const activeConnection = connection.extend({
  accessToken: z.string(),
  refreshToken: z.string(),
});
type StoredCredentialValue = Connection | string;

export interface CredentialStore {
  get(key: string): Promise<StoredCredentialValue | undefined>;
  put(key: string, value: StoredCredentialValue): Promise<void>;
  delete(key: string): Promise<boolean>;
}

async function checkedJson(response: Response) {
  if (!response.ok)
    throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function permission(scope: string | undefined) {
  if (scope && !scope.split(" ").includes("chatgpt.tokens.use.direct")) {
    throw new Error(
      "ChatGPT plan permission was not granted. Reconnect and allow plan usage.",
    );
  }
}

function refreshFailureCode(body: string): string | null {
  try {
    return z
      .object({
        error: z.union([
          z.string().transform((code) => ({ code })),
          z.object({ code: z.string() }),
        ]),
      })
      .parse(JSON.parse(body)).error.code;
  } catch {
    // SILENT: unrecognized upstream errors retain credentials and surface the raw body.
    return null;
  }
}

/** One deployment's shared plan. Only this owner ever reads renewable tokens. */
export class ChatGptSession {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: CredentialStore,
    // Workers native fetch requires its global receiver, not this session.
    private readonly upstream: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  /** Serialize mutations across HTTP awaits; rotating refresh tokens are single-use. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<Connection | null> {
    const saved = await this.store.get("connection");
    return saved ? connection.parse(saved) : null;
  }

  private summary(saved: Connection | null): ChatGptStatus {
    return {
      connected: saved?.connected ?? false,
      email: saved?.connected ? saved.email : null,
      needsReauthorization: !!saved?.connected && !saved.refreshToken,
    };
  }

  async status(): Promise<ChatGptStatus> {
    return this.summary(await this.read());
  }

  authorizationHost(): Promise<{ hostId: string; clientId: string | null }> {
    return this.serial(async () => {
      const previous = await this.store.get("hostId");
      const hostId = previous
        ? z.string().parse(previous)
        : `urn:uuid:${crypto.randomUUID()}`;
      if (!previous) await this.store.put("hostId", hostId);
      return { hostId, clientId: (await this.read())?.clientId ?? null };
    });
  }

  connect(raw: ChatGptAuthorization): Promise<ChatGptStatus> {
    return this.serial(async () => {
      const input = chatGptAuthorization.parse(raw);
      const result = tokens.parse(
        await checkedJson(
          await this.upstream(TOKEN, {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: input.clientId,
              code: input.code,
              code_verifier: input.verifier,
              redirect_uri: input.redirectUri,
              resource: API,
            }),
            signal: AbortSignal.timeout(30_000),
          }),
        ),
      );
      if (!result.scope)
        throw new Error("OpenAI did not return granted scopes");
      permission(result.scope);
      if (!result.id_token)
        throw new Error("OpenAI did not return an ID token");
      const { payload } = await jwtVerify(result.id_token, jwks, {
        issuer: AUTH,
        audience: input.clientId,
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      });
      if (payload.nonce !== input.nonce)
        throw new Error("OpenAI ID token nonce does not match");
      const identity = z
        .object({ sub: z.string(), email: z.string().optional() })
        .parse(payload);
      // Authorization is validated before replacing a working registration.
      const saved: Connection = {
        connected: true,
        clientId: input.clientId,
        subject: identity.sub,
        email: identity.email ?? null,
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + result.expires_in * 1000,
      };
      const previous = await this.read();
      if (
        previous &&
        (previous.clientId !== saved.clientId ||
          previous.subject !== saved.subject)
      ) {
        throw new Error(
          "Reconnect using the originally registered ChatGPT account",
        );
      }
      await this.store.put("connection", saved);
      await this.catalog(result.access_token);
      return this.summary(saved);
    });
  }

  private active(): Promise<z.infer<typeof activeConnection>> {
    return this.serial(async () => {
      const saved = await this.read();
      if (!saved?.connected)
        throw new Error("Connect a ChatGPT account in Settings first");
      if (!saved.refreshToken || !saved.accessToken)
        throw new Error("Reconnect ChatGPT in Settings to renew plan access");
      if (saved.expiresAt > Date.now() + 60_000)
        return activeConnection.parse(saved);
      const response = await this.upstream(TOKEN, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: saved.clientId,
          refresh_token: saved.refreshToken,
          resource: API,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body = await response.text();
        const code = refreshFailureCode(body);
        if (
          code &&
          [
            "invalid_grant",
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
          ].includes(code)
        ) {
          await this.store.put("connection", {
            ...saved,
            accessToken: null,
            refreshToken: null,
            expiresAt: 0,
          });
        }
        throw new Error(`OpenAI HTTP ${response.status}: ${body}`);
      }
      const refreshed = tokens.parse(await response.json());
      permission(refreshed.scope);
      const next = {
        ...saved,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
      };
      await this.store.put("connection", next);
      return activeConnection.parse(next);
    });
  }

  private async catalog(accessToken: string) {
    const result = chatGptModels.parse(
      await checkedJson(
        await this.upstream(`${API}/models`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        }),
      ),
    );
    return result.models.filter((model) => model.visibility === "list");
  }

  async models() {
    return this.catalog((await this.active()).accessToken);
  }

  disconnect(): Promise<void> {
    return this.serial(async () => {
      const saved = await this.read();
      if (!saved) return;
      if (saved.refreshToken) {
        const discovery = z.object({ revocation_endpoint: z.url() }).parse(
          await checkedJson(
            await this.upstream(`${AUTH}/.well-known/openid-configuration`, {
              signal: AbortSignal.timeout(30_000),
            }),
          ),
        );
        if (new URL(discovery.revocation_endpoint).origin !== AUTH)
          throw new Error("Unexpected OpenAI revocation endpoint");
        const revoked = await this.upstream(discovery.revocation_endpoint, {
          method: "POST",
          body: new URLSearchParams({
            token: saved.refreshToken,
            token_type_hint: "refresh_token",
            client_id: saved.clientId,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!revoked.ok)
          throw new Error(
            `OpenAI revocation HTTP ${revoked.status}: ${await revoked.text()}`,
          );
      }
      await this.store.put("connection", {
        ...saved,
        connected: false,
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
      });
    });
  }

  async infer(
    body: Awaited<ReturnType<typeof gatewayQuery>>,
    model: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const saved = await this.active();
    signal?.throwIfAborted();
    return this.upstream(`${API}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${saved.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chatGptRequest(body, model)),
      signal,
    });
  }
}
