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

  export const env: Env;
}
