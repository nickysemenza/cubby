// Wrangler owns Env and binding/RPC types in worker-configuration.d.ts. Runtime
// ambient generation stays disabled because the full Workers library collides
// with browser DOM globals; this declaration covers only the imported base.
declare module "cloudflare:workers" {
  interface DurableObjectStoragePort {
    get<T>(key: string): Promise<T | undefined>;
    put<Value>(key: string, value: Value): Promise<void>;
    put<Entries extends object>(entries: Entries): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTimeMs: number): Promise<void>;
  }

  interface DurableObjectStatePort {
    id: {
      readonly jurisdiction?: string;
      toString(): string;
    };
    storage: DurableObjectStoragePort;
  }

  export abstract class DurableObject<Environment> {
    protected readonly ctx: DurableObjectStatePort;
    protected readonly env: Environment;
    constructor(ctx: DurableObjectStatePort, env: Environment);
  }
}
