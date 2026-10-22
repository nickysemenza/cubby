import type { z } from "zod";

import type {
  OperationContract,
  SubscriptionMemberName,
} from "~/contracts/define";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";
import type { AuthenticatedStartOperationContext } from "~/server/operation-runtime/start-operation.server";
import {
  workflowStream,
  type WorkflowStream,
} from "~/server/operation-runtime/workflow-stream.server";

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

export type WorkflowStreamHandler = (options: {
  request: Request;
  input: UnparsedStartOperationData;
}) => Promise<WorkflowStream>;

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
): WorkflowStreamHandler {
  const inputSchema = declaredInputSchema(descriptor);
  const eventSchema = declaredEventSchema(descriptor);
  return (options) =>
    workflowStream({
      request: options.request,
      input: options.input,
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
): SubscriptionImplementationMap<Contract>;
export function implementSubscriptionDomain(
  contract: OperationContract,
  handlers: Record<string, SubscriptionRun<SubscriptionDomainDescriptor>>,
) {
  const streams: Record<string, WorkflowStreamHandler> = {};
  for (const [member, definition] of Object.entries(contract.ops)) {
    if (definition.kind !== "subscription") continue;
    const id = `${contract.domain}.${member}`;
    if (!isSubscriptionOperationId(id))
      throw new Error(`${id} is not registered as a subscription`);
    const run = handlers[member];
    if (!run) throw new Error(`Missing handler for ${id}`);
    streams[member] = streamHandlerFor({ id, definition }, run);
  }
  return { streams };
}
