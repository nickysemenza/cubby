// Wrangler owns Env and binding/RPC types in worker-configuration.d.ts. The
// full Workers library cannot share this app's DOM type graph because both
// runtimes define Element; these imported platform types keep the module
// boundary aligned with the current Workers release without merging globals.
declare module "cloudflare:workers" {
  import type {
    DurableObjectState,
    ExecutionContext,
    WorkflowEvent,
    WorkflowStep,
  } from "@cloudflare/workers-types";

  export type { WorkflowEvent, WorkflowStep };

  export abstract class DurableObject<Environment> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Environment;
    constructor(ctx: DurableObjectState, env: Environment);
  }

  export abstract class WorkflowEntrypoint<Environment, Params> {
    protected readonly ctx: ExecutionContext;
    protected readonly env: Environment;
    constructor(ctx: ExecutionContext, env: Environment);
    abstract run(
      event: Readonly<WorkflowEvent<Params>>,
      step: WorkflowStep,
    ): Promise<object>;
  }

  export abstract class WorkerEntrypoint<Environment> {
    protected readonly ctx: ExecutionContext;
    protected readonly env: Environment;
    constructor(ctx: ExecutionContext, env: Environment);
  }

  export const env: Env;
}

/** Local provider seam is absent from deployed Worker bindings. */
interface Env {
  E2E_GOOGLE_PROVIDER_URL?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Workerd harness only; see `RequestDbConnections.poolIdleTimeoutMs`. */
  CUBBY_TEST_POOL_IDLE_TIMEOUT_MS?: string;
  /** Workerd harness only; see `PurchaseAgentEnvironment.settlementPollMs`. */
  CUBBY_TEST_SETTLEMENT_POLL_MS?: string;
}
