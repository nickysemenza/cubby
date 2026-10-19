import {
  chatGptAuthorization,
  chatGptModels,
  type ChatGptAuthorizationHost,
  type ChatGptAuthorization,
  type ChatGptStatus,
} from "@cubby/schemas/chatgpt";
import type { GatewayQuery } from "@cubby/shared/ai/gateway-request";
import { retryWithBackoff } from "@cubby/shared/retry";
import { createLogger } from "@cubby/worker-tracing";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { chatGptRequest } from "./transport";

const log = createLogger("chatgpt-plan");

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
  clientId: z.string().nullable(),
  scopes: z.string().optional(),
  issue: z.string().nullable().optional(),
  welcomeDismissed: z.boolean().optional(),
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
  clientId: z.string(),
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
  if (!scope?.split(" ").includes("chatgpt.tokens.use.direct")) {
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

const planError = z.object({
  error: z.looseObject({
    type: z.string().optional(),
    code: z.string().nullish(),
    param: z.string().nullish(),
    message: z.string().nullish(),
  }),
});

/**
 * An HTTP 400 invalid request naming the `input` items (or the cache
 * breakpoint) as what it refuses: the shape a refused breakpoint takes. Quota
 * and rate refusals are funding outcomes, never request-shape errors.
 */
function isBreakpointRefusal(status: number, body: string): boolean {
  if (status !== 400) return false;
  let parsed: z.infer<typeof planError>;
  try {
    parsed = planError.parse(JSON.parse(body));
  } catch {
    // SILENT: a non-JSON refusal is not a recognizable placement refusal; the
    // caller still receives and logs its raw body.
    return false;
  }
  const { type, code, param, message } = parsed.error;
  if (type !== "invalid_request_error") return false;
  if (code && /usage_limit|rate_limit|quota/u.test(code)) return false;
  return (
    /^input(?:$|[[.])/u.test(param ?? "") ||
    (message ?? "").includes("prompt_cache_breakpoint")
  );
}

/** One deployment's shared plan. Only this owner ever reads renewable tokens. */
export class ChatGptSession {
  private pending: Promise<unknown> = Promise.resolve();
  private cacheBreakpoints = true;

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
      needsReauthorization:
        !!saved?.connected && (!saved.refreshToken || !!saved.issue),
      issue: saved?.issue ?? null,
      welcomeDismissed: saved?.welcomeDismissed ?? false,
    };
  }

  async status(): Promise<ChatGptStatus> {
    return this.summary(await this.read());
  }

  dismissWelcome(): Promise<ChatGptStatus> {
    return this.serial(async () => {
      const saved = await this.read();
      if (saved?.connected)
        await this.store.put("connection", {
          ...saved,
          welcomeDismissed: true,
        });
      return this.status();
    });
  }

  authorizationHost(): Promise<ChatGptAuthorizationHost> {
    return this.serial(async () => {
      const previous = await this.store.get("hostId");
      const hostId = previous
        ? z.string().parse(previous)
        : `urn:uuid:${crypto.randomUUID()}`;
      if (!previous) await this.store.put("hostId", hostId);
      const saved = await this.read();
      return {
        hostId,
        clientId: saved?.clientId ?? null,
        loginHint: saved?.email ?? null,
      };
    });
  }

  async connect(raw: ChatGptAuthorization): Promise<ChatGptStatus> {
    const saved = await this.serial(async () => {
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
      const previous = await this.read();
      // Authorization is validated before replacing a working registration.
      const saved: Connection = {
        connected: true,
        scopes: result.scope,
        welcomeDismissed: previous?.welcomeDismissed ?? false,
        issue: null,
        clientId: input.clientId,
        subject: identity.sub,
        email: identity.email ?? null,
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + result.expires_in * 1000,
      };
      if (
        previous &&
        ((previous.clientId !== null && previous.clientId !== saved.clientId) ||
          previous.subject !== saved.subject)
      ) {
        throw new Error(
          "Reconnect using the originally registered ChatGPT account",
        );
      }
      await this.store.put("connection", saved);
      return activeConnection.parse(saved);
    });
    await this.catalog(saved.accessToken);
    return this.summary(saved);
  }

  private active(): Promise<z.infer<typeof activeConnection>> {
    return this.serial(async () => {
      const saved = await this.read();
      if (!saved?.connected)
        throw new Error("Connect a ChatGPT account in Settings first");
      if (saved.issue) throw new Error(saved.issue);
      if (!saved.clientId || !saved.refreshToken || !saved.accessToken)
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
            "invalid_client",
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
            clientId: code === "invalid_client" ? null : saved.clientId,
            issue:
              code === "invalid_client"
                ? "OpenAI no longer accepts Cubby’s registration — connect again."
                : "Reconnect ChatGPT in Settings to renew plan access.",
            accessToken: null,
            refreshToken: null,
            expiresAt: 0,
          });
        }
        throw new Error(`OpenAI HTTP ${response.status}: ${body}`);
      }
      const refreshed = tokens.parse(await response.json());
      // Older stored connections already passed the direct-scope check at sign-in.
      const scopes =
        refreshed.scope ?? saved.scopes ?? "chatgpt.tokens.use.direct";
      let issue: string | null = null;
      try {
        permission(scopes);
      } catch (error) {
        issue = error instanceof Error ? error.message : String(error);
      }
      const next = {
        ...saved,
        scopes,
        issue,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
      };
      await this.store.put("connection", next);
      if (issue) throw new Error(issue);
      return activeConnection.parse(next);
    });
  }

  private async recordAdmissionFailure(
    status: number,
    failure: string,
    accessToken: string,
  ) {
    const code = refreshFailureCode(failure);
    if (
      (status === 403 && code === "subscription_sharing_user_not_eligible") ||
      (status === 401 && code === "subscription_sharing_invalid_user")
    ) {
      await this.serial(async () => {
        const current = await this.read();
        // An old in-flight refusal cannot disable a newer authorization.
        if (current?.accessToken === accessToken)
          await this.store.put("connection", {
            ...current,
            issue: `${code}: ${
              code === "subscription_sharing_user_not_eligible"
                ? "ChatGPT plan usage is unavailable for this account, workspace, or policy."
                : "OpenAI could not validate the ChatGPT account."
            } Reconnect ChatGPT to resume plan usage. OpenAI HTTP ${status}: ${scrubErrorMessage(failure)}`,
          });
      });
    }
  }

  private async catalog(accessToken: string) {
    const response = await this.upstream(`${API}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const failure = await response.text();
      await this.recordAdmissionFailure(response.status, failure, accessToken);
      throw new Error(`OpenAI HTTP ${response.status}: ${failure}`);
    }
    const result = chatGptModels.parse(await response.json());
    return result.models.filter((model) => model.visibility === "list");
  }

  async models() {
    return this.catalog((await this.active()).accessToken);
  }

  disconnect(): Promise<void> {
    return this.serial(async () => {
      const saved = await this.read();
      if (!saved) return;
      let issue: string | null = null;
      if (saved.refreshToken && saved.clientId) {
        const signal = AbortSignal.timeout(90_000);
        try {
          const response = await retryWithBackoff(
            async () => {
              const discovered = await this.upstream(
                `${AUTH}/.well-known/openid-configuration`,
                { signal },
              );
              if (!discovered.ok) return discovered;
              const discovery = z
                .object({ revocation_endpoint: z.url() })
                .parse(await discovered.json());
              if (new URL(discovery.revocation_endpoint).origin !== AUTH)
                throw new Error("Unexpected OpenAI revocation endpoint");
              return this.upstream(discovery.revocation_endpoint, {
                method: "POST",
                body: new URLSearchParams({
                  token: saved.refreshToken ?? "",
                  token_type_hint: "refresh_token",
                  client_id: saved.clientId ?? "",
                }),
                signal,
              });
            },
            {
              signal,
              delayFor: (outcome, attempt) => {
                const delay = [2000, 8000, 30000][attempt];
                if (delay === undefined || signal.aborted) return null;
                if (!outcome.ok) return delay;
                if (outcome.value.status < 500) return null;
                void outcome.value.body?.cancel();
                return delay;
              },
            },
          );
          if (!response.ok)
            throw new Error(
              `OpenAI revocation HTTP ${response.status}: ${await response.text()}`,
            );
        } catch (error) {
          issue =
            "Cubby cleared its tokens but couldn't confirm OpenAI revoked them; disconnect Cubby in ChatGPT settings to be sure.";
          log.warn("plan revocation unconfirmed", {
            error: scrubErrorMessage(String(error)),
          });
        }
      }
      await this.store.put("connection", {
        ...saved,
        connected: false,
        issue,
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
      });
    });
  }

  async infer(
    body: GatewayQuery,
    model: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const saved = await this.active();
    signal?.throwIfAborted();
    const request = (breakpoints: boolean) =>
      JSON.stringify(chatGptRequest(body, model, { breakpoints }));
    const send = (payload: string) =>
      retryWithBackoff(
        () =>
          this.upstream(`${API}/responses`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${saved.accessToken}`,
              "Content-Type": "application/json",
            },
            body: payload,
            signal,
          }),
        {
          signal,
          delayFor: (outcome, attempt) => {
            const delay = [2000, 8000, 30000][attempt];
            if (
              delay === undefined ||
              !outcome.ok ||
              outcome.value.status !== 503
            )
              return null;
            void outcome.value.body?.cancel();
            return delay;
          },
        },
      );
    const breakpoints = this.cacheBreakpoints;
    const first = request(breakpoints);
    let response = await send(first);
    if (response.ok) return response;
    // Every plan caller passes through here; callers that fall back to paid
    // inference otherwise keep no copy of the plan's refusal.
    let failure = await response.text();
    // CONSTRAINT: the plan's preview documents neither support nor refusal of
    // `prompt_cache_breakpoint`. A refusal of the input shape retries that
    // request once without breakpoints; when that succeeds, this session keeps
    // sending none. Delete this guard once production plan calls succeed with
    // breakpoints.
    const plain = request(false);
    if (
      breakpoints &&
      plain !== first &&
      isBreakpointRefusal(response.status, failure)
    ) {
      log.warn("plan refused cache breakpoints; retrying without", {
        model,
        status: response.status,
        body: scrubErrorMessage(failure),
      });
      signal?.throwIfAborted();
      response = await send(plain);
      if (response.ok) {
        this.cacheBreakpoints = false;
        return response;
      }
      failure = await response.text();
    }
    await this.recordAdmissionFailure(
      response.status,
      failure,
      saved.accessToken,
    );
    log.warn("plan refused inference", {
      model,
      status: response.status,
      body: scrubErrorMessage(failure),
    });
    return new Response(failure, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
