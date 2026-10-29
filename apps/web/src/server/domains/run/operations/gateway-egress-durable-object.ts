import type { DurableObjectState } from "@cloudflare/workers-types";
import { aiGatewayId, CF_ACCOUNT_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  creditRefusedResponse,
  isInferenceFundingRefusal,
  runUniversalGateway,
  runNativeGateway,
  workersAiModel,
  workersAiRunRequest,
} from "@cubby/shared/ai/gateway-request";
import { scrubCredentialValues } from "@cubby/worker-tracing/scrub-error-message";
import { DurableObject } from "cloudflare:workers";
import { count, eq, inArray, lte, max, min, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { aiBudgetWindow } from "~/server/ai/budget-window";
import {
  GATEWAY_EGRESS_LIMITS,
  isByokJevEndpoint,
  gatewayEgressInput,
  type GatewayAdmission,
} from "~/server/ai/gateway-egress-contract";

import { initializeGatewayEgress } from "../repo/gateway-egress-initialization";
import {
  cooldowns,
  creditEpochs,
  creditRefusals,
  permits,
  starts,
} from "../repo/gateway-egress-sql-schema";

const {
  windowMs: WINDOW_MS,
  requestsPerWindow: REQUESTS_PER_WINDOW,
  unifiedMaxInFlight: UNIFIED_MAX_IN_FLIGHT,
  requestDeadlineMs: REQUEST_DEADLINE_MS,
} = GATEWAY_EGRESS_LIMITS;

const TYPESAFE_BUCKET = "byok:typesafe";
const CREDIT_BUCKET = "subscriber-credit:anthropic";
const OPENAI_CREDIT_BUCKET = "subscriber-credit:openai";
const isCreditBucket = (bucket: string) =>
  bucket === CREDIT_BUCKET || bucket === OPENAI_CREDIT_BUCKET;

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

  private readonly db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    void ctx.blockConcurrencyWhile(() => initializeGatewayEgress(ctx.storage));
  }

  private creditEpoch(bucket = CREDIT_BUCKET) {
    return (
      this.db
        .select({ epoch: creditEpochs.epoch })
        .from(creditEpochs)
        .where(eq(creditEpochs.bucket, bucket))
        .get()?.epoch ?? 0
    );
  }

  private bumpCreditEpoch(bucket = CREDIT_BUCKET) {
    this.db
      .insert(creditEpochs)
      .values({ bucket, epoch: 1 })
      .onConflictDoUpdate({
        target: creditEpochs.bucket,
        set: { epoch: sql`${creditEpochs.epoch} + 1` },
      })
      .run();
  }

  private activeCreditRefusal(now: number, bucket = CREDIT_BUCKET) {
    this.db
      .delete(creditRefusals)
      .where(lte(creditRefusals.untilMs, now))
      .run();
    return this.db
      .select()
      .from(creditRefusals)
      .where(eq(creditRefusals.bucket, bucket))
      .get();
  }

  /** The selected provider credit refusal, if any. */
  async creditRefusal(now = Date.now(), provider = "anthropic") {
    const row = this.activeCreditRefusal(now, `subscriber-credit:${provider}`);
    return row ? { until: row.untilMs, reason: row.reason } : null;
  }

  /** Retry API credits now; a credit budget change too. */
  async resetCreditRefusal() {
    for (const bucket of [CREDIT_BUCKET, OPENAI_CREDIT_BUCKET]) {
      this.clearCreditRefusal(bucket);
      this.bumpCreditEpoch(bucket);
    }
  }

  private clearCreditRefusal(bucket = CREDIT_BUCKET) {
    this.db
      .delete(creditRefusals)
      .where(eq(creditRefusals.bucket, bucket))
      .run();
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
    epoch: number | undefined = undefined,
    provider = "anthropic",
  ) {
    const bucket = `subscriber-credit:${provider}`;
    const currentEpoch = this.creditEpoch(bucket);
    if (epoch !== undefined && epoch !== currentEpoch) return;
    if (status >= 200 && status < 300) return this.clearCreditRefusal(bucket);
    if (
      !isInferenceFundingRefusal(
        status,
        body,
        provider === "openai" ? "openai_credit" : "subscriber_credit",
      ) ||
      body.includes("cubby_credit_budget_reached")
    )
      return;
    // Raw diagnostics stay whole (AGENTS.md); only credentials are redacted.
    const reason = scrubCredentialValues(body);
    this.bumpCreditEpoch(bucket);
    const refusal = {
      untilMs: creditRefusalUntil(reason, now),
      reason,
      probeWindow: windowStart(now),
    };
    this.db
      .insert(creditRefusals)
      .values({ bucket, ...refusal })
      .onConflictDoUpdate({ target: creditRefusals.bucket, set: refusal })
      .run();
  }

  async admit(bucket: string, now = Date.now()): Promise<GatewayAdmission> {
    // No await between checking capacity and reserving the permit.
    this.db
      .delete(starts)
      .where(lte(starts.started, now - WINDOW_MS))
      .run();
    this.db.delete(permits).where(lte(permits.deadline, now)).run();
    const refusal = isCreditBucket(bucket)
      ? this.activeCreditRefusal(now, bucket)
      : undefined;
    const probing =
      refusal !== undefined && refusal.probeWindow < windowStart(now);
    // Refused credit answers at once so the ladder moves on without waiting.
    if (refusal && !probing)
      return {
        kind: "refused",
        until: refusal.untilMs,
        reason: refusal.reason,
      };
    const cooldown =
      this.db
        .select({ untilMs: max(cooldowns.untilMs) })
        .from(cooldowns)
        .where(
          inArray(cooldowns.bucket, [
            bucket,
            bucket === TYPESAFE_BUCKET ? bucket : "all",
          ]),
        )
        .get()?.untilMs ?? 0;
    if (cooldown > now) return { kind: "wait", until: cooldown };
    if (bucket === "unified") {
      const active = this.db
        .select({ count: count(), earliest: min(permits.deadline) })
        .from(permits)
        .where(eq(permits.bucket, bucket))
        .get();
      if (!active) throw new Error("Missing permit admission aggregate");
      if (active.count >= UNIFIED_MAX_IN_FLIGHT)
        return {
          kind: "wait",
          until: Math.min(active.earliest ?? now, now + 1_000),
        };
      const recent = this.db
        .select({ count: count(), earliest: min(starts.started) })
        .from(starts)
        .where(eq(starts.bucket, bucket))
        .get();
      if (!recent) throw new Error("Missing unified admission aggregate");
      if (recent.count >= REQUESTS_PER_WINDOW)
        return { kind: "wait", until: (recent.earliest ?? now) + WINDOW_MS };
    }
    const token = crypto.randomUUID();
    // Spent only once admitted, so a capacity wait cannot use up the probe.
    if (probing)
      this.db
        .update(creditRefusals)
        .set({ probeWindow: windowStart(now) })
        .where(eq(creditRefusals.bucket, bucket))
        .run();
    if (bucket === "unified")
      this.db.insert(starts).values({ bucket, started: now }).run();
    this.db
      .insert(permits)
      .values({ token, bucket, deadline: now + REQUEST_DEADLINE_MS })
      .run();
    return isCreditBucket(bucket)
      ? { kind: "admitted", token, epoch: this.creditEpoch(bucket) }
      : { kind: "admitted", token };
  }

  async finish(
    token: string,
    status: number,
    retryAfter: string | null,
    now = Date.now(),
  ) {
    const permit = this.db
      .select({ bucket: permits.bucket })
      .from(permits)
      .where(eq(permits.token, token))
      .get();
    if (!permit) return;
    this.db.delete(permits).where(eq(permits.token, token)).run();
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
      this.db
        .insert(cooldowns)
        .values({
          bucket: permit.bucket === "unified" ? "all" : permit.bucket,
          untilMs: until,
        })
        .onConflictDoUpdate({
          target: cooldowns.bucket,
          set: { untilMs: sql`max(${cooldowns.untilMs}, ${until})` },
        })
        .run();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const input = gatewayEgressInput.parse(await request.json());
    const byokJev = isByokJevEndpoint(input.provider, input.endpoint);
    if (byokJev && !this.env.AI_GATEWAY_API_KEY)
      throw new Error("Jev BYOK requires the AI_GATEWAY_API_KEY Worker secret");
    // Stored-key traffic does not consume Unified Billing's capacity window.
    const credit =
      (input.provider === "anthropic" || input.provider === "openai") &&
      input.headers["cf-aig-byok-alias"] === "subscriber-credit" &&
      input.headers["cf-aig-no-wholesale"] === "true";
    const admitted = await this.admit(
      byokJev
        ? TYPESAFE_BUCKET
        : credit
          ? `subscriber-credit:${input.provider}`
          : "unified",
      Date.now(),
    );
    if (admitted.kind === "refused")
      return creditRefusedResponse(admitted, input.provider);
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
      const byokRequest = byokJev
        ? workersAiRunRequest({
            accountId: CF_ACCOUNT_ID,
            token: this.env.AI_GATEWAY_API_KEY,
            model: workersAiModel(endpoint),
            input: query,
            gateway: { id: gatewayId, ...controls },
            signal: controller.signal,
          })
        : null;
      // Require stored TypeSafe credentials; never spend Unified Billing credits.
      byokRequest?.init.headers.set("cf-aig-no-wholesale", "true");
      const response = byokRequest
        ? await fetch(byokRequest.url, byokRequest.init)
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
        await this.noteCreditResponse(200, "", Date.now(), epoch, provider);
      if (credit && [400, 402, 429].includes(response.status)) {
        // Refusal bodies are small JSON errors; read one to classify it.
        const text = await response.text();
        await this.noteCreditResponse(
          response.status,
          text,
          Date.now(),
          epoch,
          provider,
        );
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
