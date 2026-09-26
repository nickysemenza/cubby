import { z } from "zod";

import type {
  OperationContract,
  OperationMemberName,
} from "~/contracts/define";
import {
  type StartOperationId,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
import { type ReadPolicy, readPolicyFor } from "~/server/read-policy";
import type { StartOperationResult } from "~/server/start-operation.contract";
import {
  type AuthenticatedStartOperationContext,
  runStartOperation,
} from "~/server/start-operation.server";

type OperationKind = "query" | "mutation";

type OperationDomainDescriptor = {
  readonly id: StartOperationId;
  readonly definition: {
    readonly kind: OperationKind;
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

type OperationHandlerContext = AuthenticatedStartOperationContext & {
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

export type OperationExecutionOptions<Input, OutputSchema extends z.ZodType> = {
  operation: StartOperationId;
  type: OperationKind;
  input: z.input<z.ZodUnknown>;
  inputSchema: z.ZodType<Input>;
  outputSchema: OutputSchema | ((input: Input) => OutputSchema);
  request: Parameters<StartOperationHandler>[0]["request"];
  readPolicy: ReadPolicy;
  run: (
    context: AuthenticatedStartOperationContext,
    input: Input,
  ) => Promise<z.input<OutputSchema>>;
};

/** Injectable execution seam; production delegates to runStartOperation. */
export interface OperationExecutionAdapter {
  execute<Input, OutputSchema extends z.ZodType>(
    options: OperationExecutionOptions<Input, OutputSchema>,
  ): Promise<StartOperationResult<z.output<OutputSchema>>>;
}

const startOperationExecutionAdapter = {
  execute: runStartOperation,
} satisfies OperationExecutionAdapter;

type OperationDescriptorOf<
  Contract extends OperationContract,
  Member extends keyof Contract["ops"],
> = {
  readonly id: StartOperationId;
  readonly definition: Extract<
    Contract["ops"][Member],
    { kind: OperationKind }
  >;
};

/**
 * The handler as MCP calls it: the caller has already authenticated and
 * selected a read policy, and validates input and output itself.
 */
export type DirectOperationRun = {
  readonly id: StartOperationId;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly run: (
    context: OperationHandlerContext,
    input: z.output<z.ZodUnknown>,
  ) => Promise<z.output<z.ZodUnknown>>;
};

type OperationImplementationMap<Contract extends OperationContract> = {
  contract: Contract;
  runs: Readonly<Record<string, DirectOperationRun>>;
  operations: {
    readonly [
      Member in OperationMemberName<Contract["ops"]>
    ]: StartOperationHandler<
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

function operationHandlerFor<Descriptor extends OperationDomainDescriptor>(
  descriptor: Descriptor,
  entry: OperationHandlerEntry<Descriptor>,
  adapter: OperationExecutionAdapter,
): StartOperationHandler<DeclaredOutput<Descriptor>> {
  const configured = configuredOperationHandler(entry);
  const inputSchema = configured.input ?? declaredInputSchema(descriptor);
  const outputSchema = configured.output ?? declaredOutputSchema(descriptor);

  return (options) => {
    const execution: OperationExecutionOptions<
      DeclaredInput<Descriptor>,
      RuntimeOutputSchema<Descriptor>
    > = {
      operation: descriptor.id,
      type: descriptor.definition.kind,
      input: options.data,
      inputSchema,
      outputSchema,
      request: options.request,
      readPolicy: readPolicyFor(descriptor.id, descriptor.definition.kind),
      run: (context, parsed) =>
        configured.run({ ...context, signal: options.request.signal }, parsed),
    };
    return adapter.execute(execution);
  };
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
  adapter?: OperationExecutionAdapter,
): OperationImplementationMap<Contract>;
export function implementOperationDomain(
  contract: OperationContract,
  handlers: Record<string, OperationHandlerEntry<OperationDomainDescriptor>>,
  adapter: OperationExecutionAdapter = startOperationExecutionAdapter,
) {
  const operations: Record<
    string,
    StartOperationHandler<z.output<z.ZodUnknown>>
  > = {};
  const runs: Record<string, DirectOperationRun> = {};
  for (const [member, definition] of Object.entries(contract.ops)) {
    if (definition.kind === "subscription") continue;
    const operation = startOperationDefinitionFor(
      `${contract.domain}.${member}`,
    );
    if (!operation)
      throw new Error(
        `${contract.domain}.${member} is missing from the generated registry`,
      );
    const entry = handlers[member];
    if (!entry) throw new Error(`Missing handler for ${operation.id}`);
    operations[member] = operationHandlerFor(
      { id: operation.id, definition },
      entry,
      adapter,
    );
    const configured = configuredOperationHandler(entry);
    runs[member] = {
      id: operation.id,
      input: configured.input ?? definition.input,
      output:
        configured.output instanceof z.ZodType
          ? configured.output
          : definition.output,
      run: configured.run,
    };
  }
  return { contract, runs, operations };
}
