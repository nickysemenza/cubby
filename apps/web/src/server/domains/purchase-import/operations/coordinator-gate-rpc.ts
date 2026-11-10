// Types only: the global worker-environment.d.ts reaches this file through
// worker-bindings.ts, so it imports nothing with runtime code.

export type CoordinatorTurnGrant =
  | { held: true; leaseUntil: number }
  | { held: false; position: number; holders: number; waiting: number };

export type CoordinatorGateRequest = {
  runId: string;
  agent: string;
  token: string;
};

/** Runs holding a turn and runs queued for one, in queue order. */
export type CoordinatorGateStatus = { holders: string[]; waiting: string[] };

/** The singleton gate's RPC surface (`CoordinatorGateDurableObject`). */
export interface CoordinatorGateRpc {
  acquire(request: CoordinatorGateRequest): Promise<CoordinatorTurnGrant>;
  release(
    request: Omit<CoordinatorGateRequest, "agent">,
  ): Promise<{ released: boolean }>;
  /** Runs holding or queued for a turn now (stale-Run expiry skips them). */
  status(): Promise<CoordinatorGateStatus>;
}
