import type { z } from "zod";

import type {
  OperationContract,
  SubscriptionMemberName,
} from "~/contracts/define";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
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

type SubscriptionDescriptorOf<
  Contract extends OperationContract,
  Member extends keyof Contract["ops"],
> = {
  readonly id: StartOperationIdOfKind<"subscription">;
  readonly definition: Extract<
    Contract["ops"][Member],
    { kind: "subscription" }
  >;
};

type SubscriptionImplementationMap<Contract extends OperationContract> = {
  streams: {
    readonly [
      Member in SubscriptionMemberName<Contract["ops"]>
    ]: WorkflowStreamHandler;
  };
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

function isSubscriptionOperationId(
  id: string,
): id is StartOperationIdOfKind<"subscription"> {
  return startOperationDefinitionFor(id)?.kind === "subscription";
}

/**
 * Implement the `subscription` members of a contract; query/mutation members
 * of the same contract belong to `implementOperationDomain`.
 */
export function implementSubscriptionDomain<Contract extends OperationContract>(
  contract: Contract,
  handlers: {
    [Member in SubscriptionMemberName<Contract["ops"]>]: SubscriptionRun<
      SubscriptionDescriptorOf<Contract, Member>
    >;
  },
  adapter?: WorkflowStreamExecutionAdapter,
): SubscriptionImplementationMap<Contract>;
export function implementSubscriptionDomain(
  contract: OperationContract,
  handlers: Record<string, SubscriptionRun<SubscriptionDomainDescriptor>>,
  adapter: WorkflowStreamExecutionAdapter = productionStreamExecutionAdapter,
) {
  const streams: Record<string, WorkflowStreamHandler> = {};
  for (const [member, definition] of Object.entries(contract.ops)) {
    if (definition.kind !== "subscription") continue;
    const id = `${contract.domain}.${member}`;
    if (!isSubscriptionOperationId(id))
      throw new Error(`${id} is not registered as a subscription`);
    const run = handlers[member];
    if (!run) throw new Error(`Missing handler for ${id}`);
    streams[member] = streamHandlerFor({ id, definition }, run, adapter);
  }
  return { streams };
}
