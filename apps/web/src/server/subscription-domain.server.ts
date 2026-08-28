import type { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import type { Workload } from "~/server/workload";

type SubscriptionDomainDescriptor = {
  readonly id: StartOperationIdOfKind<"subscription">;
  readonly definition: {
    readonly kind: "subscription";
    readonly input: z.ZodType;
    readonly event: z.ZodType;
  };
};

type DeclaredSubscriptionInput<
  Descriptor extends SubscriptionDomainDescriptor,
> = z.output<Descriptor["definition"]["input"]>;

type SubscriptionRun<Descriptor extends SubscriptionDomainDescriptor> = (
  context: AuthenticatedStartOperationContext,
  input: DeclaredSubscriptionInput<Descriptor>,
  /** Aborts when the browser drops the stream; pass it into workflows. */
  signal: AbortSignal,
) =>
  | AsyncIterable<z.input<Descriptor["definition"]["event"]>>
  | Promise<AsyncIterable<z.input<Descriptor["definition"]["event"]>>>;

/** Produces the NDJSON response for one stream request. */
export type WorkflowStreamHandler = (options: {
  request: Request;
}) => Promise<Response>;

export type WorkflowStreamExecutionOptions<
  Input,
  EventSchema extends z.ZodType,
> = {
  request: Request;
  operation: StartOperationIdOfKind<"subscription">;
  inputSchema: z.ZodType<Input>;
  eventSchema: EventSchema;
  workload?: Workload;
  run: (
    context: AuthenticatedStartOperationContext,
    input: Input,
    signal: AbortSignal,
  ) =>
    | AsyncIterable<z.input<EventSchema>>
    | Promise<AsyncIterable<z.input<EventSchema>>>;
};

/** Injectable streaming seam; production delegates to workflowStreamResponse. */
export interface WorkflowStreamExecutionAdapter {
  respond<Input, EventSchema extends z.ZodType>(
    options: WorkflowStreamExecutionOptions<Input, EventSchema>,
  ): Promise<Response>;
}

const productionStreamExecutionAdapter = {
  respond<Input, EventSchema extends z.ZodType>(
    options: WorkflowStreamExecutionOptions<Input, EventSchema>,
  ) {
    return workflowStreamResponse(options);
  },
} satisfies WorkflowStreamExecutionAdapter;

type SubscriptionImplementationMap<
  Domain extends Record<string, SubscriptionDomainDescriptor>,
> = {
  streams: { readonly [Member in keyof Domain]: WorkflowStreamHandler };
};

function declaredInputSchema<Descriptor extends SubscriptionDomainDescriptor>(
  descriptor: Descriptor,
): z.ZodType<DeclaredSubscriptionInput<Descriptor>>;
function declaredInputSchema(descriptor: SubscriptionDomainDescriptor) {
  return descriptor.definition.input;
}

function declaredEventSchema<Descriptor extends SubscriptionDomainDescriptor>(
  descriptor: Descriptor,
): z.ZodType<z.output<Descriptor["definition"]["event"]>>;
function declaredEventSchema(descriptor: SubscriptionDomainDescriptor) {
  return descriptor.definition.event;
}

function streamHandlerFor<Descriptor extends SubscriptionDomainDescriptor>(
  descriptor: Descriptor,
  run: SubscriptionRun<Descriptor>,
  adapter: WorkflowStreamExecutionAdapter,
): WorkflowStreamHandler {
  const inputSchema = declaredInputSchema(descriptor);
  const eventSchema = declaredEventSchema(descriptor);
  return (options) =>
    adapter.respond({
      request: options.request,
      operation: descriptor.id,
      inputSchema,
      eventSchema,
      run,
    });
}

export function implementSubscriptionDomain<
  Domain extends Record<string, SubscriptionDomainDescriptor>,
>(
  domain: Domain,
  handlers: {
    [Member in keyof Domain]: SubscriptionRun<Domain[Member]>;
  },
  adapter?: WorkflowStreamExecutionAdapter,
): SubscriptionImplementationMap<Domain>;
export function implementSubscriptionDomain<
  Domain extends Record<string, SubscriptionDomainDescriptor>,
>(
  domain: Domain,
  handlers: { [Member in keyof Domain]: SubscriptionRun<Domain[Member]> },
  adapter: WorkflowStreamExecutionAdapter = productionStreamExecutionAdapter,
) {
  const streams: Record<string, WorkflowStreamHandler> = {};
  for (const member in domain) {
    const descriptor = domain[member];
    const run = handlers[member];
    if (!descriptor) throw new Error(`Missing descriptor for ${member}`);
    if (!run) throw new Error(`Missing handler for ${descriptor.id}`);
    streams[member] = streamHandlerFor(descriptor, run, adapter);
  }
  return { streams };
}
