/**
 * The Worker's Durable Object and Workflow classes, as entry shells.
 *
 * Wrangler requires each class to be exported from the Worker entry, and
 * workerd evaluates the entry's whole static import graph at isolate startup.
 * Each class here therefore imports nothing but `cloudflare:workers` and types:
 * it loads its implementation with one `import()` on its first event, and
 * everything below that import is static. `cubby/worker-lazy-import-boundary`
 * keeps `import()` to these shells and a short allowlist.
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import * as Sentry from "@sentry/cloudflare";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import type { ChatGptPlanRpc } from "./ai/chatgpt/rpc";
import type { CalendarFeedDurableObjectRpc } from "./calendar/rpc";
import type { DatabaseFreshnessRpc } from "./database-freshness/rpc";
import type { ImageProcessingCompanionRpc } from "./image-processing/contracts";
import type { PurchaseImportRunAgentRpc } from "./purchase-agent/environment";
import type { PurchaseImportDurableObjectRpc } from "./purchase-import/rpc";
import type { UsdaReleaseRpc } from "./usda-release/rpc";
import type {
  MailDiscoveryWorkflow as MailDiscoveryEntrypoint,
  SearchIndexRepairWorkflow as SearchIndexRepairEntrypoint,
  SearchIndexRepairWorkflowParams,
  VendorMailSearchWorkflow as VendorMailSearchEntrypoint,
} from "./worker-bindings";
import { workerSentryOptions } from "./worker-sentry";
import type { WorkflowRunParams } from "./workflow-runs/contract";

/** An implementation's one-time setup, run before any event reaches it. */
interface DurableObjectImplementation {
  initialize?(): Promise<void>;
}

type ImplementationClass<I> = new (ctx: DurableObjectState, env: Env) => I;

/** What a forwarded method returns; the shell passes it through untouched. */
declare const forwardedResult: unique symbol;
type ForwardedResult = { readonly [forwardedResult]: true };

/** An implementation viewed as its forwarded methods. */
type ForwardTarget = Record<
  string,
  ((...args: readonly unknown[]) => ForwardedResult) | undefined
>;

/**
 * A Durable Object class that constructs `load()`'s implementation inside
 * `blockConcurrencyWhile`, so no event reaches the object before its module is
 * evaluated and its `initialize()` has finished, and that forwards `methods`
 * (RPC methods and platform handlers such as `fetch` or `alarm`) to it.
 * workerd dispatches both from the class prototype, which is where they live.
 */
function durableObjectShell<I extends object, K extends keyof I & string>(
  load: () => Promise<ImplementationClass<I>>,
  methods: Record<K, true>,
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & Pick<I, K> {
  let implementationClass: Promise<ImplementationClass<I>> | undefined;
  // Off the instance, so the shell instance type stays plain `DurableObject`.
  const implementations = new WeakMap<object, I>();
  class Shell extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      void ctx.blockConcurrencyWhile(async () => {
        const Implementation = await (implementationClass ??= load());
        const implementation = new Implementation(ctx, env);
        // SAFETY: `initialize` is optional; an implementation without it
        // reads as `undefined` here.
        await (implementation as DurableObjectImplementation).initialize?.();
        implementations.set(this, implementation);
      });
    }
  }
  for (const method of Object.keys(methods)) {
    Object.defineProperty(Shell.prototype, method, {
      configurable: true,
      writable: true,
      value(this: Shell, ...args: unknown[]) {
        const implementation = implementations.get(this);
        if (!implementation)
          throw new Error(`Durable Object received ${method} before it loaded`);
        // SAFETY: `methods` is keyed by `K`, so each entry names a method of `I`.
        return (implementation as ForwardTarget)[method]!(...args);
      },
    });
  }
  // SAFETY: the loop above defines every `K` on the prototype.
  return Shell as new (
    ctx: DurableObjectState,
    env: Env,
  ) => DurableObject<Env> & Pick<I, K>;
}

export class ChatGptPlanDurableObject
  extends durableObjectShell<
    import("./ai/chatgpt/durable-object").ChatGptPlanObject,
    keyof ChatGptPlanRpc
  >(
    () =>
      import("./ai/chatgpt/durable-object").then((m) => m.ChatGptPlanObject),
    {
      status: true,
      authorizationHost: true,
      authorizePlan: true,
      models: true,
      disconnect: true,
      infer: true,
      cancel: true,
    },
  )
  implements ChatGptPlanRpc {}

export class CalendarFeedDurableObject
  extends durableObjectShell<
    import("./calendar/durable-object").CalendarFeedObject,
    keyof CalendarFeedDurableObjectRpc | "fetch" | "alarm"
  >(
    () => import("./calendar/durable-object").then((m) => m.CalendarFeedObject),
    {
      fetch: true,
      alarm: true,
      clearUncertainWrite: true,
      getCalendarCredential: true,
      rotateCalendarCredential: true,
      revokeCalendarCredential: true,
      getToken: true,
      inspect: true,
      rotate: true,
      read: true,
      markDirty: true,
      refreshNow: true,
    },
  )
  implements CalendarFeedDurableObjectRpc {}

export class DatabaseFreshnessDurableObject
  extends durableObjectShell<
    import("./database-freshness/durable-object").DatabaseFreshnessObject,
    keyof DatabaseFreshnessRpc | "alarm"
  >(
    () =>
      import("./database-freshness/durable-object").then(
        (m) => m.DatabaseFreshnessObject,
      ),
    {
      alarm: true,
      readFreshness: true,
      recordWrite: true,
      getProblemCounts: true,
    },
  )
  implements DatabaseFreshnessRpc {}

export class ImageProcessingDurableObject
  extends durableObjectShell<
    import("./image-processing/durable-object").ImageProcessingObject,
    | keyof ImageProcessingCompanionRpc
    | "fetch"
    | "webSocketMessage"
    | "webSocketError"
  >(
    () =>
      import("./image-processing/durable-object").then(
        (m) => m.ImageProcessingObject,
      ),
    {
      fetch: true,
      dispatch: true,
      webSocketMessage: true,
      webSocketError: true,
    },
  )
  implements ImageProcessingCompanionRpc {}

export class PurchaseImportDurableObject
  extends durableObjectShell<
    import("./purchase-import/durable-object").PurchaseImportObject,
    | keyof PurchaseImportDurableObjectRpc
    | "fetch"
    | "webSocketMessage"
    | "webSocketError"
    | "webSocketClose"
  >(
    () =>
      import("./purchase-import/durable-object").then(
        (m) => m.PurchaseImportObject,
      ),
    {
      fetch: true,
      webSocketMessage: true,
      webSocketError: true,
      webSocketClose: true,
      forgetRun: true,
      enqueue: true,
      result: true,
      cancel: true,
      connected: true,
      pendingCommands: true,
      notifyRunCompleted: true,
      requestAuthentication: true,
    },
  )
  implements PurchaseImportDurableObjectRpc {}

class PurchaseImportRunAgentShell
  extends durableObjectShell<
    import("./purchase-import/agent-host").PurchaseImportRunAgentHost,
    keyof PurchaseImportRunAgentRpc | "fetch" | "alarm"
  >(
    () =>
      import("./purchase-import/agent-host").then(
        (m) => m.PurchaseImportRunAgentHost,
      ),
    { fetch: true, alarm: true, dispatch: true, retire: true },
  )
  implements PurchaseImportRunAgentRpc {}

// The Worker's own Sentry configuration (`withSentry` in cf-server.ts covers
// the queue consumer); the tag separates the agent's issues.
export const PurchaseImportRunAgent = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    ...workerSentryOptions(env),
    initialScope: { tags: { service: "purchase-agent" } },
  }),
  PurchaseImportRunAgentShell,
);

export class UsdaReleaseDurableObject
  extends durableObjectShell<
    import("./usda-release/durable-object").UsdaReleaseObject,
    keyof UsdaReleaseRpc | "alarm"
  >(
    () =>
      import("./usda-release/durable-object").then((m) => m.UsdaReleaseObject),
    {
      alarm: true,
      status: true,
      resume: true,
      counts: true,
      getFood: true,
      lookupBatch: true,
      search: true,
    },
  )
  implements UsdaReleaseRpc {}

export class SearchIndexRepairWorkflow
  extends WorkflowEntrypoint<Env, SearchIndexRepairWorkflowParams>
  implements SearchIndexRepairEntrypoint
{
  async run(
    event: Readonly<WorkflowEvent<SearchIndexRepairWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const { runSearchIndexRepairWorkflow } =
      await import("./search-index-repair-workflow");
    return runSearchIndexRepairWorkflow(this.env, event, step);
  }
}

export class VendorMailSearchWorkflow
  extends WorkflowEntrypoint<Env, WorkflowRunParams>
  implements VendorMailSearchEntrypoint
{
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ) {
    const { runVendorMailSearchWorkflow } = await import("./gmail-workflows");
    return runVendorMailSearchWorkflow(this.env, event, step);
  }
}

export class MailDiscoveryWorkflow
  extends WorkflowEntrypoint<Env, WorkflowRunParams>
  implements MailDiscoveryEntrypoint
{
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ) {
    const { runMailDiscoveryWorkflow } = await import("./gmail-workflows");
    return runMailDiscoveryWorkflow(this.env, event, step);
  }
}
