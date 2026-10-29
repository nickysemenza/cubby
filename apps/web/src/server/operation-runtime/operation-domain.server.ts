import { z } from "zod";

import type {
  OperationContract,
  OperationMemberName,
} from "~/contracts/define";
import type { OperationId } from "~/lib/operation-observability";
import { readPolicyFor } from "~/server/db/read-policy";
import { resolveFilterTokens } from "~/server/entity-kernel/filter-tokens";
import type { OperationHandler } from "~/server/operation-runtime/operation-handlers.server";
import {
  type AuthenticatedOperationContext,
  resolveOperation,
  executeOperation,
} from "~/server/operation-runtime/operation.server";

type UnaryOperationKind = "query" | "mutation";

type OperationDomainDescriptor = {
  readonly id: OperationId;
  readonly definition: {
    readonly kind: UnaryOperationKind;
    readonly input: z.ZodType;
    readonly output: z.ZodType;
  };
};

type DeclaredInput<Descriptor extends OperationDomainDescriptor> = z.output<
  Descriptor["definition"]["input"]
>;

type DeclaredOutput<Descriptor extends OperationDomainDescriptor> = z.output<
  Descriptor["definition"]["output"]
>;

type OperationHandlerContext = AuthenticatedOperationContext & {
  /** Aborts when the browser cancels the request; pass it into workflows. */
  signal: AbortSignal;
};

type OperationRun<Descriptor extends OperationDomainDescriptor> = (
  context: OperationHandlerContext,
  input: DeclaredInput<Descriptor>,
) => Promise<z.input<Descriptor["definition"]["output"]>>;

type RuntimeInputSchema<Descriptor extends OperationDomainDescriptor> =
  z.ZodType<DeclaredInput<Descriptor>>;

type RuntimeOutputSchema<Descriptor extends OperationDomainDescriptor> =
  z.ZodType<DeclaredOutput<Descriptor>>;

type OutputSchemaResolver<Descriptor extends OperationDomainDescriptor> = (
  input: DeclaredInput<Descriptor>,
) => RuntimeOutputSchema<Descriptor>;

type ConfiguredOperationHandler<Descriptor extends OperationDomainDescriptor> =
  {
    run: OperationRun<Descriptor>;
    /** Replaces a type-only client schema with server-owned runtime validation. */
    input?: RuntimeInputSchema<Descriptor>;
    /** Replaces or derives server-owned runtime output validation. */
    output?: RuntimeOutputSchema<Descriptor> | OutputSchemaResolver<Descriptor>;
  };

export type OperationHandlerEntry<
  Descriptor extends OperationDomainDescriptor,
> = OperationRun<Descriptor> | ConfiguredOperationHandler<Descriptor>;

function isOperationRun<Descriptor extends OperationDomainDescriptor>(
  entry: OperationHandlerEntry<Descriptor>,
): entry is OperationRun<Descriptor> {
  return typeof entry === "function";
}

function configuredOperationHandler<
  Descriptor extends OperationDomainDescriptor,
>(
  entry: OperationHandlerEntry<Descriptor>,
): ConfiguredOperationHandler<Descriptor> {
  return isOperationRun(entry) ? { run: entry } : entry;
}

type OperationDescriptorOf<
  Contract extends OperationContract,
  Member extends keyof Contract["ops"],
> = {
  readonly id: OperationId;
  readonly definition: Extract<
    Contract["ops"][Member],
    { kind: UnaryOperationKind }
  >;
};

type OperationImplementationMap<Contract extends OperationContract> = {
  contract: Contract;
  operations: {
    readonly [Member in OperationMemberName<Contract["ops"]>]: OperationHandler<
      DeclaredOutput<OperationDescriptorOf<Contract, Member>>
    >;
  };
};

function declaredInputSchema<Descriptor extends OperationDomainDescriptor>(
  descriptor: Descriptor,
): RuntimeInputSchema<Descriptor>;
function declaredInputSchema(descriptor: OperationDomainDescriptor) {
  return descriptor.definition.input;
}

function declaredOutputSchema<Descriptor extends OperationDomainDescriptor>(
  descriptor: Descriptor,
): RuntimeOutputSchema<Descriptor>;
function declaredOutputSchema(descriptor: OperationDomainDescriptor) {
  return descriptor.definition.output;
}

/**
 * A query's run with `@me` resolved in every Ledger Party filter its input
 * schema declares (ADR 0018), and relative date tokens in every date bound
 * (#2415), so no read handler forwards a token to a repository unresolved.
 */
function resolvingCurrentMember<Descriptor extends OperationDomainDescriptor>(
  kind: Descriptor["definition"]["kind"],
  inputSchema: z.ZodType,
  run: OperationRun<Descriptor>,
): OperationRun<Descriptor> {
  if (kind !== "query") return run;
  return async (context, input) =>
    run(context, await resolveFilterTokens(context, inputSchema, input));
}

function operationHandlerFor<Descriptor extends OperationDomainDescriptor>(
  descriptor: Descriptor,
  entry: OperationHandlerEntry<Descriptor>,
): OperationHandler<DeclaredOutput<Descriptor>> {
  const configured = configuredOperationHandler(entry);
  const inputSchema = configured.input ?? declaredInputSchema(descriptor);
  const outputSchema = configured.output ?? declaredOutputSchema(descriptor);
  const run = resolvingCurrentMember(
    descriptor.definition.kind,
    inputSchema,
    configured.run,
  );

  return (options) =>
    executeOperation({
      operation: descriptor.id,
      type: descriptor.definition.kind,
      input: options.data,
      inputSchema,
      outputSchema,
      request: options.request,
      readPolicy: readPolicyFor(descriptor.id, descriptor.definition.kind),
      run: (context, parsed, signal) => run({ ...context, signal }, parsed),
    });
}

/**
 * Implement the `query` / `mutation` members of a contract. Subscription
 * members of the same contract belong to `implementSubscriptionDomain`; the
 * generated registry checks that every declared member has exactly one
 * implementer of the matching kind.
 */
export function implementOperationDomain<Contract extends OperationContract>(
  contract: Contract,
  handlers: {
    [Member in OperationMemberName<Contract["ops"]>]: OperationHandlerEntry<
      OperationDescriptorOf<Contract, Member>
    >;
  },
): OperationImplementationMap<Contract>;
export function implementOperationDomain(
  contract: OperationContract,
  handlers: Record<string, OperationHandlerEntry<OperationDomainDescriptor>>,
) {
  const operations: Record<
    string,
    OperationHandler<z.output<z.ZodUnknown>>
  > = {};
  for (const [member, definition] of Object.entries(contract.ops)) {
    if (definition.kind === "subscription") continue;
    const resolved = resolveOperation(`${contract.domain}.${member}`, {
      kinds: [definition.kind],
      exposure: "internal",
    });
    if (!resolved.ok) throw new Error(resolved.error.message);
    const operation = resolved.definition;
    const entry = handlers[member];
    if (!entry) throw new Error(`Missing handler for ${operation.id}`);
    operations[member] = operationHandlerFor(
      { id: operation.id, definition },
      entry,
    );
  }
  return { contract, operations };
}
