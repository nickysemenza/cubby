import type { DurableObjectState } from "@cloudflare/workers-types";
import { aiGatewayId, CF_ACCOUNT_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  creditRefusedResponse,
  isInferenceFundingRefusal,
  runUniversalGateway,
  runNativeGateway,
  workersAiModel,
} from "@cubby/shared/ai/gateway-request";
import { scrubCredentialValues } from "@cubby/worker-tracing/scrub-error-message";
import { DurableObject } from "cloudflare:workers";

import { aiBudgetWindow } from "~/server/ai/budget-window";
import {
  GATEWAY_EGRESS_LIMITS,
  TYPESAFE_EGRESS_LIMITS,
  isDirectJevEndpoint,
  gatewayEgressInput,
  type GatewayAdmission,
} from "~/server/ai/gateway-egress-contract";

const {
  windowMs: WINDOW_MS,
  requestsPerWindow: REQUESTS_PER_WINDOW,
  unifiedMaxInFlight: UNIFIED_MAX_IN_FLIGHT,
  requestDeadlineMs: REQUEST_DEADLINE_MS,
} = GATEWAY_EGRESS_LIMITS;

const TYPESAFE_BUCKET = "direct:typesafe";
const CREDIT_BUCKET = "subscriber-credit:anthropic";

const windowStart = (now: number) =>
  aiBudgetWindow(new Date(now)).start.getTime();

/**
 * When a credit refusal lifts: the date Anthropic names ("You will regain
 * access on 2026-11-01 at 00:00 UTC"), else the end of the current credit
 * window.
 */
function creditRefusalUntil(reason: string, now: number) {
  const named =
    /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{1,2}):(\d{2}))?/u.exec(
      reason,
    );
  const at = named
    ? Date.parse(
        `${named[1]}T${(named[2] ?? "0").padStart(2, "0")}:${named[3] ?? "00"}:00Z`,
      )
    : NaN;
  return Number.isFinite(at) && at > now
    ? at
    : aiBudgetWindow(new Date(now)).end.getTime();
}

/** One identity per gateway; subscription requests never enter this object. */
export class AiGatewayEgressDurableObject extends DurableObject<Env> {
  /** Read the running DO code, never a caller's or a retained observation's version. */
  async currentDeploymentVersion(): Promise<string> {
    return this.env.CF_VERSION_METADATA.id;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Postgres Jobs now retain startup, recovery and funding intent.
    void ctx.blockConcurrencyWhile(() => ctx.storage.deleteAlarm());
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS starts (bucket TEXT NOT NULL, started INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS starts_time ON starts(started)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS permits (token TEXT PRIMARY KEY, bucket TEXT NOT NULL, deadline INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cooldowns (bucket TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS typesafe_starts (started INTEGER NOT NULL, input_tokens INTEGER NOT NULL)",
    );
    // A provider credit refusal (ADR 0017) refuses credit admission until
    // `until_ms`, except one probe per six-hour window; `probe_window` is the
    // start of the window whose probe is spent.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS credit_refusals (bucket TEXT PRIMARY KEY, until_ms INTEGER NOT NULL, reason TEXT NOT NULL, probe_window INTEGER NOT NULL)",
    );
    // Bumped by every reset and every recorded refusal. A credit response is
    // observed only under the epoch its request was admitted in, so a request
    // in flight across a reset cannot re-record the refusal it cleared, and an
    // older success cannot clear a newer refusal.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS credit_epochs (bucket TEXT PRIMARY KEY, epoch INTEGER NOT NULL)",
    );
  }

  private creditEpoch() {
    return (
      this.ctx.storage.sql
        .exec<{ epoch: number }>(
          "SELECT epoch FROM credit_epochs WHERE bucket = ?",
          CREDIT_BUCKET,
        )
        .toArray()[0]?.epoch ?? 0
    );
  }

  private bumpCreditEpoch() {
    this.ctx.storage.sql.exec(
      "INSERT INTO credit_epochs VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET epoch = epoch + 1",
      CREDIT_BUCKET,
    );
  }

  private activeCreditRefusal(now: number) {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM credit_refusals WHERE until_ms <= ?", now);
    return sql
      .exec<{ until_ms: number; reason: string; probe_window: number }>(
        "SELECT until_ms, reason, probe_window FROM credit_refusals WHERE bucket = ?",
        CREDIT_BUCKET,
      )
      .toArray()[0];
  }

  /** The active Claude credit refusal, if any. */
  async creditRefusal(now = Date.now()) {
    const row = this.activeCreditRefusal(now);
    return row ? { until: row.until_ms, reason: row.reason } : null;
  }

  /** The member's "Retry Claude credit now"; a credit budget change too. */
  async resetCreditRefusal() {
    this.clearCreditRefusal();
    this.bumpCreditEpoch();
  }

  private clearCreditRefusal() {
    this.ctx.storage.sql.exec(
      "DELETE FROM credit_refusals WHERE bucket = ?",
      CREDIT_BUCKET,
    );
  }

  /**
   * A credit response's effect on the refusal: success clears it; a
   * recognized provider funding refusal records (or re-records) it with its
   * raw body. Cubby's own window stop (`cubby_credit_budget_reached`) resets
   * with its window and never records. `epoch` is the request's admission
   * epoch; a response from before the latest reset or refusal is ignored.
   */
  async noteCreditResponse(
    status: number,
    body: string,
    now = Date.now(),
    epoch = this.creditEpoch(),
  ) {
    if (epoch !== this.creditEpoch()) return;
    if (status >= 200 && status < 300) return this.clearCreditRefusal();
    if (
      !isInferenceFundingRefusal(status, body, "subscriber_credit") ||
      body.includes("cubby_credit_budget_reached")
    )
      return;
    // Raw diagnostics stay whole (AGENTS.md); only credentials are redacted.
    const reason = scrubCredentialValues(body);
    this.bumpCreditEpoch();
    this.ctx.storage.sql.exec(
      "INSERT INTO credit_refusals VALUES (?, ?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason, probe_window = excluded.probe_window",
      CREDIT_BUCKET,
      creditRefusalUntil(reason, now),
      reason,
      windowStart(now),
    );
  }

  async admit(
    bucket: string,
    now = Date.now(),
    inputTokens = 0,
  ): Promise<GatewayAdmission> {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM starts WHERE started <= ?", now - WINDOW_MS);
    sql.exec("DELETE FROM permits WHERE deadline <= ?", now);
    const refusal =
      bucket === CREDIT_BUCKET ? this.activeCreditRefusal(now) : undefined;
    const probing =
      refusal !== undefined && refusal.probe_window < windowStart(now);
    // Refused credit answers at once so the ladder moves on without waiting.
    if (refusal && !probing)
      return {
        kind: "refused",
        until: refusal.until_ms,
        reason: refusal.reason,
      };
    if (bucket === TYPESAFE_BUCKET) {
      sql.exec(
        "DELETE FROM typesafe_starts WHERE started <= ?",
        now - TYPESAFE_EGRESS_LIMITS.windowMs,
      );
      const recent = sql
        .exec<{ count: number; tokens: number; earliest: number | null }>(
          "SELECT count(*) AS count, coalesce(sum(input_tokens), 0) AS tokens, min(started) AS earliest FROM typesafe_starts",
        )
        .one();
      if (inputTokens > TYPESAFE_EGRESS_LIMITS.inputTokensPerWindow)
        throw new Error(
          "Jev request exceeds the direct-provider admission token budget; reduce the batch size",
        );
      if (
        recent.count >= TYPESAFE_EGRESS_LIMITS.requestsPerWindow ||
        recent.tokens + inputTokens >
          TYPESAFE_EGRESS_LIMITS.inputTokensPerWindow
      )
        return {
          kind: "wait",
          until: (recent.earliest ?? now) + TYPESAFE_EGRESS_LIMITS.windowMs,
        };
    }
    const cooldown =
      sql
        .exec<{ until_ms: number }>(
          "SELECT max(until_ms) AS until_ms FROM cooldowns WHERE bucket IN (?, ?)",
          bucket,
          bucket === TYPESAFE_BUCKET ? bucket : "all",
        )
        .one().until_ms ?? 0;
    if (cooldown > now) return { kind: "wait", until: cooldown };
    const active = sql
      .exec<{ count: number; earliest: number }>(
        "SELECT count(*) AS count, min(deadline) AS earliest FROM permits WHERE bucket = ?",
        bucket,
      )
      .one();
    if (
      bucket === TYPESAFE_BUCKET &&
      active.count >= TYPESAFE_EGRESS_LIMITS.maxInFlight
    )
      return { kind: "wait", until: Math.min(active.earliest, now + 1_000) };
    if (bucket === "unified" && active.count >= UNIFIED_MAX_IN_FLIGHT)
      return { kind: "wait", until: Math.min(active.earliest, now + 1_000) };
    if (bucket === "unified") {
      const starts = sql
        .exec<{ count: number; earliest: number }>(
          "SELECT count(*) AS count, min(started) AS earliest FROM starts WHERE bucket = ?",
          bucket,
        )
        .one();
      if (starts.count >= REQUESTS_PER_WINDOW)
        return { kind: "wait", until: starts.earliest + WINDOW_MS };
    }
    const token = crypto.randomUUID();
    // Spent only once admitted, so a capacity wait cannot use up the probe.
    if (probing)
      sql.exec(
        "UPDATE credit_refusals SET probe_window = ? WHERE bucket = ?",
        windowStart(now),
        CREDIT_BUCKET,
      );
    if (bucket === TYPESAFE_BUCKET)
      sql.exec("INSERT INTO typesafe_starts VALUES (?, ?)", now, inputTokens);
    sql.exec("INSERT INTO starts VALUES (?, ?)", bucket, now);
    sql.exec(
      "INSERT INTO permits VALUES (?, ?, ?)",
      token,
      bucket,
      now + REQUEST_DEADLINE_MS,
    );
    return bucket === CREDIT_BUCKET
      ? { kind: "admitted", token, epoch: this.creditEpoch() }
      : { kind: "admitted", token };
  }

  async finish(
    token: string,
    status: number,
    retryAfter: string | null,
    now = Date.now(),
  ) {
    const sql = this.ctx.storage.sql;
    const permit = sql
      .exec<{ bucket: string }>(
        "SELECT bucket FROM permits WHERE token = ?",
        token,
      )
      .toArray()[0];
    if (!permit) return;
    sql.exec("DELETE FROM permits WHERE token = ?", token);
    if (status === 429) {
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const parsed = Number.isFinite(seconds)
        ? now + seconds * 1_000
        : Date.parse(retryAfter ?? "");
      const until = Math.max(
        now + 1_000,
        Number.isFinite(parsed) ? parsed : now + 1_000,
      );
      // Unified responses have unknown limit scope; credit refusals must leave paid fallback available.
      sql.exec(
        "INSERT INTO cooldowns VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET until_ms = max(until_ms, excluded.until_ms)",
        permit.bucket === "unified" ? "all" : permit.bucket,
        until,
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const input = gatewayEgressInput.parse(await request.json());
    const directJev = isDirectJevEndpoint(input.provider, input.endpoint);
    if (directJev && !this.env.TYPESAFE_API_KEY)
      throw new Error("Direct Jev requires the TYPESAFE_API_KEY Worker secret");
    const directBody = JSON.stringify({ ...input.query, model: "jev-1.13.0" });
    // UTF-8 bytes plus framing conservatively overestimate textual input tokens.
    const inputTokens = new TextEncoder().encode(directBody).length + 1024;
    // Stored-key traffic does not consume Unified Billing's capacity window.
    const credit =
      input.provider === "anthropic" &&
      input.headers["cf-aig-byok-alias"] === "subscriber-credit" &&
      input.headers["cf-aig-no-wholesale"] === "true";
    const admitted = await this.admit(
      directJev ? TYPESAFE_BUCKET : credit ? CREDIT_BUCKET : "unified",
      Date.now(),
      directJev ? inputTokens : 0,
    );
    if (admitted.kind === "refused") return creditRefusedResponse(admitted);
    if (admitted.kind === "wait")
      return new Response(
        "AI Gateway admission is waiting for shared capacity",
        {
          status: 429,
          headers: {
            "retry-after": String(
              Math.max(1, Math.ceil((admitted.until - Date.now()) / 1_000)),
            ),
            "x-cubby-admission-wait": "true",
          },
        },
      );
    const { token, epoch } = admitted;
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("AI Gateway egress deadline exceeded")),
      Math.min(
        input.controls.requestTimeoutMs ?? REQUEST_DEADLINE_MS,
        REQUEST_DEADLINE_MS,
      ),
    );
    let finished = false;
    const finish = async (status: number, retryAfter: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      await this.finish(token, status, retryAfter);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    controller.signal.addEventListener(
      "abort",
      () => {
        this.ctx.waitUntil(
          Promise.allSettled([reader?.cancel(controller.signal.reason)]).then(
            () => finish(0, null),
          ),
        );
      },
      { once: true },
    );
    if (request.signal.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const { provider, endpoint, query, controls } = input;
      const gatewayId = aiGatewayId(controls.metadata.environment);
      const outbound = {
        endpoint,
        input: new URL(`https://gateway.internal/${endpoint}`),
        init: { method: "POST" },
        headers: new Headers(input.headers),
        signal: controller.signal,
        query: async () => query,
      };
      if (credit && !this.env.AI_GATEWAY_API_KEY)
        throw new Error(
          "Named subscriber-credit BYOK requires the AI_GATEWAY_API_KEY Worker secret for native gateway authentication",
        );
      const response = directJev
        ? await fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.TYPESAFE_API_KEY}`,
              "content-type": "application/json",
            },
            body: directBody,
            signal: controller.signal,
          })
        : credit
          ? await runNativeGateway({
              accountId: CF_ACCOUNT_ID,
              gatewayId,
              provider,
              token: this.env.AI_GATEWAY_API_KEY,
              request: outbound,
              controls,
            })
          : provider === "workers-ai"
            ? await this.env.AI.run(workersAiModel(endpoint), query, {
                gateway: { id: gatewayId, ...controls },
                returnRawResponse: true,
                signal: controller.signal,
              })
            : await runUniversalGateway(
                this.env.AI.gateway(gatewayId),
                provider,
                outbound,
                { id: gatewayId, ...controls },
              );
      if (!(response instanceof Response))
        throw new Error("AI Gateway returned no raw Response");
      if (credit && response.ok)
        await this.noteCreditResponse(200, "", Date.now(), epoch);
      if (credit && [400, 402, 429].includes(response.status)) {
        // Refusal bodies are small JSON errors; read one to classify it.
        const text = await response.text();
        await this.noteCreditResponse(response.status, text, Date.now(), epoch);
        await finish(response.status, response.headers.get("retry-after"));
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      if (response.status === 429 || !response.body) {
        await finish(response.status, response.headers.get("retry-after"));
        return response;
      }
      const upstreamReader = response.body.getReader();
      reader = upstreamReader;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = await upstreamReader.read();
            if (next.done) {
              await finish(response.status, null);
              stream.close();
            } else stream.enqueue(next.value);
          } catch (error) {
            await finish(response.status, null);
            stream.error(error);
          }
        },
        async cancel(reason) {
          controller.abort(reason);
          try {
            await upstreamReader.cancel(reason);
          } finally {
            await finish(response.status, null);
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      await finish(0, null);
      throw error;
    }
  }
}
