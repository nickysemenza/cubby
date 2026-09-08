// Wrangler owns Env and binding/RPC types in worker-configuration.d.ts. Runtime
// ambient generation stays disabled because the full Workers library collides
// with browser DOM globals; this declaration covers only the imported base.
declare module "cloudflare:workers" {
  import type { DurableObjectState } from "@cloudflare/workers-types";

  export abstract class DurableObject<Environment> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Environment;
    constructor(ctx: DurableObjectState, env: Environment);
  }
  export const env: Env;
}
