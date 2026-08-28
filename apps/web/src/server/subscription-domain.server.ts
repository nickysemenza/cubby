import type { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { workflowStreamResponse } from "~/server/workflow-stream.server";

/**
 * Server-side implementation table for a client subscription domain.
 *
 * The sibling of `implementOperationDomain`, one layer down: it pairs a
 * `defineOperationDomain` descriptor object whose members are `subscription()`
 * declarations with one handler per member, and wraps each pair in
 * `workflowStreamResponse` unchanged — the same-origin check, the actor
 * lookup, per-event `eventSchema.parse`, and the NDJSON framing all stay below
 * this seam. The handler table is a mapped type over the domain's members, so
 * a missing or extra key is a typecheck error.
 *
 * What this deletes is the hand-written route file each stream used to need,
 * whose hardcoded URL string was a typo away from a runtime 404 that no build
 * would catch. Both the client `open()` and the one dispatch route now derive
 * the URL from the operation id.
 */

/**
 * Structural view of a `subscription()` member descriptor, named here so this
 * module never imports the browser Query-integration layer (the same trick
 * `operation-domain.server.ts` uses). The event schema is keyed `event`, not
 * `output`, which is precisely what keeps a subscription from satisfying
 * `OperationDomainDescriptor` — the two tables cannot be crossed by accident.
 */
type SubscriptionDomainDescriptor = {
  readonly id: string;
  readonly definition: {
    readonly kind: "subscription";
    readonly input: z.ZodType;
    readonly event: z.ZodType;
  };
};

type SubscriptionRun<Descriptor extends SubscriptionDomainDescriptor> = (
  context: AuthenticatedStartOperationContext,
  input: z.output<Descriptor["definition"]["input"]>,
  /** Aborts when the browser drops the stream; pass it into long workflows. */
  signal: AbortSignal,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

/** Produces the NDJSON response for one stream request. */
export type WorkflowStreamHandler = (options: {
  request: Request;
}) => Promise<Response>;

type ErasedSubscriptionRun = (
  context: AuthenticatedStartOperationContext,
  input: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export function implementSubscriptionDomain<
  Domain extends Record<string, SubscriptionDomainDescriptor>,
>(
  domain: Domain,
  handlers: { [Member in keyof Domain]: SubscriptionRun<Domain[Member]> },
): {
  streams: { readonly [Member in keyof Domain]: WorkflowStreamHandler };
} {
  const streams: Record<string, WorkflowStreamHandler> = {};
  for (const [member, descriptor] of Object.entries(domain)) {
    const run = handlers[member as keyof Domain] as
      | ErasedSubscriptionRun
      | undefined;
    if (!run) throw new Error(`Missing handler for ${descriptor.id}`);
    streams[member] = (options) =>
      workflowStreamResponse({
        request: options.request,
        operation: descriptor.id as StartOperationIdOfKind<"subscription">,
        inputSchema: descriptor.definition.input,
        eventSchema: descriptor.definition.event,
        run,
      });
  }
  return {
    streams: streams as { [Member in keyof Domain]: WorkflowStreamHandler },
  };
}
