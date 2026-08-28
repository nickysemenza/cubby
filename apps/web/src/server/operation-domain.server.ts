import type { z } from "zod";

import type { StartOperationId } from "~/lib/start-operation-observability";
import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
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
    /** Overrides the default policy (queries "context", mutations "strong"). */
    readPolicy?: "context" | "strong";
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
  operation: string;
  type: OperationKind;
  input: z.input<z.ZodUnknown>;
  inputSchema: z.ZodType<Input>;
  outputSchema: OutputSchema | ((input: Input) => OutputSchema);
  request: Parameters<StartOperationHandler>[0]["request"];
  readPolicy?: "context" | "strong";
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

type OperationImplementationMap<
  Domain extends Record<string, OperationDomainDescriptor>,
> = {
  operations: {
    readonly [Member in keyof Domain]: StartOperationHandler<
      DeclaredOutput<Domain[Member]>
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
      run: (context, parsed) =>
        configured.run({ ...context, signal: options.request.signal }, parsed),
    };
    if (configured.readPolicy) execution.readPolicy = configured.readPolicy;
    return adapter.execute(execution);
  };
}

export function implementOperationDomain<
  Domain extends Record<string, OperationDomainDescriptor>,
>(
  domain: Domain,
  handlers: {
    [Member in keyof Domain]: OperationHandlerEntry<Domain[Member]>;
  },
  adapter?: OperationExecutionAdapter,
): OperationImplementationMap<Domain>;
export function implementOperationDomain<
  Domain extends Record<string, OperationDomainDescriptor>,
>(
  domain: Domain,
  handlers: {
    [Member in keyof Domain]: OperationHandlerEntry<Domain[Member]>;
  },
  adapter: OperationExecutionAdapter = startOperationExecutionAdapter,
) {
  const operations: Record<
    string,
    StartOperationHandler<z.output<z.ZodUnknown>>
  > = {};
  for (const member in domain) {
    const descriptor = domain[member];
    const entry = handlers[member];
    if (!descriptor) throw new Error(`Missing descriptor for ${member}`);
    if (!entry) throw new Error(`Missing handler for ${descriptor.id}`);
    operations[member] = operationHandlerFor(descriptor, entry, adapter);
  }
  return { operations };
}
