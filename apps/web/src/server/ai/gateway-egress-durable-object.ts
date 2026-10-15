import type { DurableObjectState } from "@cloudflare/workers-types";
import { aiGatewayId } from "@cubby/shared/ai/gateway-metadata";
import {
  runUniversalGateway,
  workersAiModel,
} from "@cubby/shared/ai/gateway-request";
import { DurableObject } from "cloudflare:workers";

import { isMaintenanceMode } from "../http/maintenance";
import {
  gatewayEgressInput,
  type GatewayAdmission,
} from "./gateway-egress-contract";

const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 180;
const MAX_IN_FLIGHT = 4;
const REQUEST_DEADLINE_MS = 10 * 60_000;

/** One identity per gateway; subscription requests never enter this object. */
export class AiGatewayEgressDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
  }

  private observation: Promise<void> | undefined;

  /** Callers cannot install their own manifest, including during rollback. */
  observeAiRefresh() {
    if (isMaintenanceMode(this.env)) return Promise.resolve();
    if (this.observation) return this.observation;
    this.observation = this.observeCurrentVersion().finally(() => {
      this.observation = undefined;
    });
    return this.observation;
  }

  private async observeCurrentVersion() {
    const version = this.env.CF_VERSION_METADATA.id;
    const epoch = await this.ctx.blockConcurrencyWhile(async () => {
      const pending = await this.ctx.storage.get<{
        version: string;
        epoch: number;
      }>("aiRefreshPendingObservation");
      if (
        !pending &&
        (await this.ctx.storage.get("aiRefreshObservedVersion")) === version
      )
        return null;
      if (
        pending &&
        pending.version === version &&
        ((await this.ctx.storage.getAlarm()) ?? 0) > Date.now()
      )
        return null;
      const epoch =
        pending && pending.version === version
          ? pending.epoch
          : ((await this.ctx.storage.get<number>(
              "aiRefreshObservationEpoch",
            )) ?? 0) + 1;
      await this.ctx.storage.put({
        aiRefreshObservationEpoch: epoch,
        aiRefreshPendingObservation: { version, epoch },
      });
      // Persist before external work. A replacement allocates a newer Neon fencing epoch.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return epoch;
    });
    if (epoch === null) return;
    const activeEpoch = await (
      await import("../workflows/ai-refresh-startup")
    ).observeAiRefreshFeatures(this.env, epoch);
    if (activeEpoch > epoch) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const nextEpoch = activeEpoch + 1;
        await this.ctx.storage.put({
          aiRefreshObservationEpoch: nextEpoch,
          aiRefreshPendingObservation: { version, epoch: nextEpoch },
        });
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      });
      throw new Error(
        `AI refresh observation fenced: attempted epoch ${epoch}, active epoch ${activeEpoch}; durable retry scheduled`,
      );
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put("aiRefreshObservedVersion", version);
      await this.ctx.storage.delete("aiRefreshPendingObservation");
      if (
        Object.keys(
          (await this.ctx.storage.get<Record<string, string>>(
            "manualAiWorkWakes",
          )) ?? {},
        ).length
      )
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      else await this.ctx.storage.deleteAlarm();
    });
  }

  async alarm() {
    (await import("../cf-env")).setCfEnv(this.env);
    if (isMaintenanceMode(this.env)) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
      return;
    }
    const results = await Promise.allSettled([
      this.observeAiRefresh(),
      this.recoverAiWorkWakes(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async scheduleAiWorkRecovery(runId?: string) {
    if (runId)
      (await import("@cubby/schemas/identifiers")).runEntityId.parse(runId);
    await this.ctx.blockConcurrencyWhile(async () => {
      const pending =
        (await this.ctx.storage.get<Record<string, string>>(
          "manualAiWorkWakes",
        )) ?? {};
      pending[runId ?? "authorization"] = crypto.randomUUID();
      await this.ctx.storage.put("manualAiWorkWakes", pending);
      const next = Date.now() + 60_000;
      await this.ctx.storage.setAlarm(
        Math.min((await this.ctx.storage.getAlarm()) ?? next, next),
      );
    });
  }

  private async recoverAiWorkWakes() {
    const pending =
      (await this.ctx.storage.get<Record<string, string>>(
        "manualAiWorkWakes",
      )) ?? {};
    const keys = Object.keys(pending);
    if (!keys.length) return;
    const { withRequestDbClient, db } = await import("../db");
    await withRequestDbClient(
      this.env.HYPERDRIVE.connectionString,
      async () => {
        const { recoverManualAiWork } =
          await import("../domains/run/service/ai-work");
        await recoverManualAiWork(
          db,
          undefined,
          keys.includes("authorization") ? undefined : keys,
        );
      },
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        (await this.ctx.storage.get<Record<string, string>>(
          "manualAiWorkWakes",
        )) ?? {};
      for (const key of keys)
        if (current[key] === pending[key]) delete current[key];
      await this.ctx.storage.put("manualAiWorkWakes", current);
      if (Object.keys(current).length)
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  async admit(bucket: string, now = Date.now()): Promise<GatewayAdmission> {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM starts WHERE started <= ?", now - WINDOW_MS);
    sql.exec("DELETE FROM permits WHERE deadline <= ?", now);
    const cooldown =
      sql
        .exec<{ until_ms: number }>(
          "SELECT max(until_ms) AS until_ms FROM cooldowns WHERE bucket IN (?, 'all')",
          bucket,
        )
        .one().until_ms ?? 0;
    if (cooldown > now) return { kind: "wait", until: cooldown };
    const active = sql
      .exec<{ count: number; earliest: number }>(
        "SELECT count(*) AS count, min(deadline) AS earliest FROM permits",
      )
      .one();
    if (active.count >= MAX_IN_FLIGHT)
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
    sql.exec("INSERT INTO starts VALUES (?, ?)", bucket, now);
    sql.exec(
      "INSERT INTO permits VALUES (?, ?, ?)",
      token,
      bucket,
      now + REQUEST_DEADLINE_MS,
    );
    return { kind: "admitted", token };
  }

  async finish(
    token: string,
    status: number,
    retryAfter: string | null,
    now = Date.now(),
  ) {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<{ bucket: string }>(
        "SELECT bucket FROM permits WHERE token = ?",
        token,
      )
      .toArray();
    if (!rows.length) return;
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
      // A response need not identify which upstream enforced the limit; share unknown-scope cooldowns.
      sql.exec(
        "INSERT INTO cooldowns VALUES ('all', ?) ON CONFLICT(bucket) DO UPDATE SET until_ms = max(until_ms, excluded.until_ms)",
        until,
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const input = gatewayEgressInput.parse(await request.json());
    // Binding calls use managed credentials. BYOK routes can be added with an explicit billing declaration.
    const admitted = await this.admit("unified");
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
    const { token } = admitted;
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
      const response =
        provider === "workers-ai"
          ? await this.env.AI.run(workersAiModel(endpoint), query, {
              gateway: { id: gatewayId, ...controls },
              returnRawResponse: true,
              signal: controller.signal,
            })
          : await runUniversalGateway(
              this.env.AI.gateway(gatewayId),
              provider,
              {
                endpoint,
                input: new URL(`https://gateway.internal/${endpoint}`),
                init: { method: "POST" },
                headers: new Headers(input.headers),
                signal: controller.signal,
                query: async () => query,
              },
              { id: gatewayId, ...controls },
            );
      if (!(response instanceof Response))
        throw new Error("AI Gateway returned no raw Response");
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
