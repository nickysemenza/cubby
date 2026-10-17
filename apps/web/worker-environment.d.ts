// Keep this outside src: repository-only compiler programs load src ambient types
// without importing the app's RPC composition graph.
import type { InferEnv, InferDurableNamespaces } from "cf/config";
import type { Rpc } from "@cloudflare/workers-types";
import type { productionWorker } from "./cloudflare.config";
import type { ConfiguredWorkerRpc as WorkerBindings } from "./src/server/worker-bindings";

type Worker = typeof productionWorker;
type InferredEnv = InferEnv<Worker>;
// Local/test profiles supply different text values. RPC types stay behind the
// type-only contracts so a global declaration never imports server implementation.
type RuntimeEnv = {
  [K in keyof InferredEnv]: Worker["env"][K] extends {
    type: "durable-object";
    exportName: infer E extends keyof WorkerBindings;
  }
    ? DurableObjectNamespace<
        Extract<WorkerBindings[E], Rpc.DurableObjectBranded>
      >
    : Worker["env"][K] extends {
          type: "workflow";
          exportName: infer E extends keyof WorkerBindings;
        }
      ? WorkerBindings[E] extends {
          run(event: { payload: infer P }, step: never): Promise<object>;
        }
        ? Workflow<P>
        : InferredEnv[K]
      : InferredEnv[K] extends string
        ? string
        : InferredEnv[K];
};

declare global {
  interface Env extends RuntimeEnv {}
  namespace Cloudflare {
    interface Env extends RuntimeEnv {}
    interface GlobalProps {
      mainModule: WorkerBindings;
      durableNamespaces: InferDurableNamespaces<Worker>;
    }
  }
}
