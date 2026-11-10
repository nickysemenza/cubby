import type { DurableObjectState } from "@cloudflare/workers-types";
import { createLogger } from "@cubby/worker-tracing";
import { DurableObject } from "cloudflare:workers";

import {
  CoordinatorGateQueue,
  type CoordinatorGateState,
} from "./coordinator-gate";
import type {
  CoordinatorGateRequest,
  CoordinatorGateRpc,
  CoordinatorGateStatus,
  CoordinatorTurnGrant,
} from "./coordinator-gate-rpc";

const STATE_KEY = "gate";
const log = createLogger("purchase-agent.gate");

/**
 * The one household coordinator gate (`COORDINATOR_GATE_NAME`): admission to
 * coordinator turns without Postgres, so a waiting coordinator opens no
 * database scope. Its queue lives in this object's storage; its alarm reclaims
 * lapsed turns and reservations, and every freed slot wakes the coordinator it
 * was reserved for (`turnReady`).
 */
export class CoordinatorGateDurableObject
  extends DurableObject<Env>
  implements CoordinatorGateRpc
{
  private queue = new CoordinatorGateQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<CoordinatorGateState>(STATE_KEY);
      if (stored) this.queue = new CoordinatorGateQueue(stored);
    });
  }

  async acquire(
    request: CoordinatorGateRequest,
  ): Promise<CoordinatorTurnGrant> {
    const { grant, notify } = this.queue.acquire(request, Date.now());
    await this.commit(notify);
    return grant;
  }

  async release(
    request: Omit<CoordinatorGateRequest, "agent">,
  ): Promise<{ released: boolean }> {
    const { released, notify } = this.queue.release(request, Date.now());
    await this.commit(notify);
    return { released };
  }

  async status(): Promise<CoordinatorGateStatus> {
    const { status, notify } = this.queue.status(Date.now());
    await this.commit(notify);
    return status;
  }

  async alarm(): Promise<void> {
    await this.commit(this.queue.tick(Date.now()));
  }

  /** Persist, re-arm for the next lapse, then wake newly reserved coordinators. */
  private async commit(notify: readonly string[]) {
    await this.ctx.storage.put(STATE_KEY, this.queue.state);
    const next = this.queue.nextChangeAt();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    for (const agent of notify)
      this.ctx.waitUntil(
        this.env.PURCHASE_IMPORT_RUN.getByName(agent)
          .turnReady()
          // The reserved coordinator's own poll still finds its reservation.
          .catch((error: unknown) =>
            log.warn("coordinator turn notification failed", { agent, error }),
          ),
      );
  }
}
