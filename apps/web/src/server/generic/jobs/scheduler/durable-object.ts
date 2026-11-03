import type { DurableObjectState } from "@cloudflare/workers-types";
import type { JobShortcode } from "@cubby/schemas/identifiers";
import {
  schedulerSnapshot,
  type SchedulerSnapshot,
} from "@cubby/schemas/job-scheduler";
import { BACKGROUND_TASK_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";
import { DurableObject } from "cloudflare:workers";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { withCfEnv } from "~/server/cf-env";
import { notifyDatabaseChanges } from "~/server/db/freshness/client";

import type { JobSchedulerRpc } from "./rpc";

const log = createLogger("job-scheduler");
const initial = (): SchedulerSnapshot => ({
  observedAt: null,
  deadlines: [],
  alarmAt: null,
  deliveryPendingSince: null,
  deliveryAttempts: 0,
  observationAttempts: 0,
  observationError: null,
  lastRecovery: null,
  events: [],
});

/** Stores only wake obligations and bounded diagnostics. PostgreSQL owns every Job. */
export class JobSchedulerDurableObject
  extends DurableObject<Env>
  implements JobSchedulerRpc
{
  private state = initial();
  private tail: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = schedulerSnapshot.parse(
        (await ctx.storage.get("scheduler")) ?? initial(),
      );
    });
  }

  // Serialize observations without holding Cloudflare's 30-second constructor gate.
  // A failed observation leaves its durable retry alarm and does not poison later work.
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async record(
    event: string,
    cause: string,
    error: string | null = null,
    job: JobShortcode | null = null,
  ) {
    this.state.events = [
      ...this.state.events,
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        event,
        job,
        cause,
        error,
      },
    ].slice(-100);
    await this.ctx.storage.put("scheduler", this.state);
    log.info(event, { cause, error, job });
    // Ring existing subscribers only for transitions; no SQL or idle heartbeat.
    await withCfEnv(this.env, () => notifyDatabaseChanges({ run: null }));
  }

  async snapshot(): Promise<SchedulerSnapshot> {
    return this.serialize(async () => {
      const alarm = await this.ctx.storage.getAlarm();
      return {
        ...this.state,
        alarmAt: alarm === null ? null : new Date(alarm).toISOString(),
      };
    });
  }

  // Serialize across database awaits: a late reconciliation cannot overwrite a newer wake.
  async reconcile(cause: string, job?: JobShortcode): Promise<string | null> {
    return this.serialize(async () =>
      (await this.refresh(cause, job)) ? null : this.state.observationError,
    );
  }

  private async readDeadlines() {
    const [{ db, withInvocationDb }, { jobDeadlines }] = await Promise.all([
      import("~/server/db"),
      import("~/server/generic/jobs/repo/deadlines"),
    ]);
    return withCfEnv(this.env, () =>
      withInvocationDb(this.env.HYPERDRIVE_BACKGROUND.connectionString, () =>
        jobDeadlines(db),
      ),
    );
  }

  private async refresh(cause: string, job?: JobShortcode): Promise<boolean> {
    // An observation must not silently erase an alarm that became due in flight.
    if (
      cause !== "alarm" &&
      this.state.deadlines.some(
        (deadline) => Date.parse(deadline.at) <= Date.now(),
      )
    )
      await this.deliver("elapsed-deadline");
    let deadlines: SchedulerSnapshot["deadlines"];
    try {
      deadlines = await this.readDeadlines();
    } catch (error) {
      // Own the bounded observation retry, rather than layering it with platform retries.
      this.state.observationAttempts++;
      this.state.observationError = scrubErrorMessage(
        JSON.stringify(describeErrorCauses(error)),
      );
      await this.arm();
      await this.record(
        "reconciliation-failed",
        cause,
        this.state.observationError,
      );
      return false;
    }
    this.state.deadlines = deadlines;
    this.state.observedAt = new Date().toISOString();
    this.state.observationAttempts = 0;
    this.state.observationError = null;
    await this.arm();
    await this.record(
      cause === "job.claim"
        ? "execution-claimed"
        : cause === "job.settled"
          ? "execution-settled"
          : cause === "drain.finished"
            ? "drain-finished"
            : "deadlines-observed",
      cause,
      null,
      job ?? null,
    );
    return true;
  }

  async wake(cause: string): Promise<void> {
    await this.serialize(async () => {
      this.state.deliveryPendingSince ??= new Date().toISOString();
      this.state.deliveryAttempts = 0;
      // Persist a fallback before sending; an interrupted RPC still has a wake obligation.
      await this.ctx.storage.put("scheduler", this.state);
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
      await this.refresh(cause);
      await this.deliver(cause);
      await this.arm();
      await this.ctx.storage.put("scheduler", this.state);
    });
  }

  private async deliver(cause: string) {
    this.state.deliveryPendingSince ??= new Date().toISOString();
    try {
      await this.sendWake();
    } catch (error) {
      this.state.deliveryAttempts++;
      await this.record(
        "wake-failed",
        cause,
        scrubErrorMessage(JSON.stringify(describeErrorCauses(error))),
      );
      return;
    }
    // Persistence failures must propagate; the queue has already accepted this wake.
    this.state.deliveryPendingSince = null;
    this.state.deliveryAttempts = 0;
    await this.record("wake-accepted", cause);
  }

  private sendWake(): Promise<void> {
    return this.env.BACKGROUND_QUEUE.send({
      version: BACKGROUND_TASK_MESSAGE_VERSION,
      queueType: "background",
    });
  }

  private async arm() {
    const retry =
      this.state.deliveryPendingSince && this.state.deliveryAttempts < 6
        ? Date.now() +
          Math.min(60_000, 1_000 * 2 ** this.state.deliveryAttempts)
        : Infinity;
    const observationRetry =
      this.state.observationError && this.state.observationAttempts < 6
        ? Date.now() +
          Math.min(60_000, 1_000 * 2 ** this.state.observationAttempts)
        : Infinity;
    const deadline = this.state.deadlines.find(
      (entry) =>
        !this.state.observationError || Date.parse(entry.at) > Date.now(),
    )?.at;
    const next = Math.min(
      retry,
      observationRetry,
      deadline ? Date.parse(deadline) : Infinity,
    );
    this.state.alarmAt = Number.isFinite(next)
      ? new Date(next).toISOString()
      : null;
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      await this.record("alarm-fired", "deadline");
      this.state.deliveryPendingSince ??= new Date().toISOString();
      await this.deliver("deadline");
      await this.refresh("alarm");
    });
  }

  async recovered(cause: string, error: string | null): Promise<void> {
    await this.serialize(async () => {
      this.state.lastRecovery = { at: new Date().toISOString(), cause, error };
      await this.record("recovery", cause, error);
    });
  }

  async claimBootstrap(version: string): Promise<string | null> {
    return this.serialize(async () => {
      const completed = await this.ctx.storage.get<string>("version");
      const pending = await this.ctx.storage.get<{
        version: string;
        token: string;
        until: number;
      }>("bootstrap");
      if (
        completed === version ||
        (pending?.version === version && pending.until > Date.now())
      )
        return null;
      const token = crypto.randomUUID();
      await this.ctx.storage.put("bootstrap", {
        version,
        token,
        until: Date.now() + 60_000,
      });
      return token;
    });
  }

  async finishBootstrap(
    version: string,
    token: string,
    error: string | null,
  ): Promise<void> {
    await this.serialize(async () => {
      const pending = await this.ctx.storage.get<{
        version: string;
        token: string;
      }>("bootstrap");
      if (pending?.version !== version || pending.token !== token) return;
      if (error === null) await this.ctx.storage.put("version", version);
      await this.ctx.storage.delete("bootstrap");
      this.state.lastRecovery = {
        at: new Date().toISOString(),
        cause: "deployment enrollment",
        error,
      };
      await this.record("deployment-enrollment", version, error);
    });
  }

  async admitDaily(date: string): Promise<string | null> {
    return this.serialize(async () => {
      const previous = await this.ctx.storage.get<{
        date: string;
        token: string;
        until: number;
        complete: boolean;
      }>("daily");
      if (
        previous?.date === date &&
        (previous.complete || previous.until > Date.now())
      )
        return null;
      const token = crypto.randomUUID();
      await this.ctx.storage.put("daily", {
        date,
        token,
        until: Date.now() + 5 * 60_000,
        complete: false,
      });
      return token;
    });
  }

  async finishDaily(
    date: string,
    token: string,
    error: string | null,
  ): Promise<void> {
    await this.serialize(async () => {
      const pending = await this.ctx.storage.get<{
        date: string;
        token: string;
      }>("daily");
      if (pending?.date !== date || pending.token !== token) return;
      await this.ctx.storage.put("daily", {
        date,
        token,
        until: 0,
        complete: error === null,
      });
      this.state.lastRecovery = {
        at: new Date().toISOString(),
        cause: "daily enrollment",
        error,
      };
      await this.record("daily-enrollment", "daily", error);
    });
  }
}
