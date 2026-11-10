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

/** The singleton gate's RPC surface (`CoordinatorGateDurableObject`). */
export interface CoordinatorGateRpc {
  acquire(request: CoordinatorGateRequest): Promise<CoordinatorTurnGrant>;
  release(
    request: Omit<CoordinatorGateRequest, "agent">,
  ): Promise<{ released: boolean }>;
  /** Runs queued for a turn now (stale-Run expiry skips them). */
  waiting(): Promise<string[]>;
}
