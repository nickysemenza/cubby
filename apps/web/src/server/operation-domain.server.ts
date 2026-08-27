import type { z } from "zod";
import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
import {
  type AuthenticatedStartOperationContext,
  runStartOperation,
} from "~/server/start-operation.server";

/**
 * Server-side implementation table for a client operation domain.
 *
 * `implementOperationDomain(domain, handlers)` pairs a `defineOperationDomain`
 * descriptor object with one handler per member and wraps each pair in
 * `runStartOperation` unchanged — registry lookup, observability, abort
 * checks, auth context, read-policy selection, and input/output parsing all
 * stay below this seam. The handler table is a mapped type over the domain's
 * members, so a missing or extra key is a typecheck error, and the returned
 * `operations` record is already `StartOperationHandler`-shaped, so the
 * generated loader needs no casts.
 */

type OperationHandlerContext = AuthenticatedStartOperationContext & {
  /** Aborts when the browser cancels the request; pass it into workflows. */
  signal: AbortSignal;
};

/**
 * Structural view of a `defineOperationDomain` member descriptor. Only the
 * facts the server needs are named here so this module never imports the
 * browser Query-integration layer.
 */
type OperationDomainDescriptor = {
  readonly id: string;
  readonly definition: {
    readonly kind: "query" | "mutation";
    readonly input: z.ZodType;
    readonly output: z.ZodType;
  };
};

type DeclaredInput<Descriptor extends OperationDomainDescriptor> = z.output<
  Descriptor["definition"]["input"]
>;

type OperationRun<Descriptor extends OperationDomainDescriptor> = (
  context: OperationHandlerContext,
  input: DeclaredInput<Descriptor>,
) => Promise<unknown>;

export type OperationHandlerEntry<
  Descriptor extends OperationDomainDescriptor,
> =
  | OperationRun<Descriptor>
  | {
      run: OperationRun<Descriptor>;
      /** Overrides the default policy (queries "context", mutations "strong"). */
      readPolicy?: "context" | "strong";
      /**
       * Runtime replacement for the declared input schema. The parsed value
       * stays typed by the client declaration — for the `entity.*` operations
       * the client declares a type-only `z.custom` schema and the server owns
       * real validation.
       */
      input?: z.ZodType;
      /**
       * Runtime replacement for the declared output schema; the function form
       * derives the schema from the parsed input.
       */
      output?: z.ZodType | ((input: DeclaredInput<Descriptor>) => z.ZodType);
    };

/**
 * Type-erased entry shape used internally. Per-member input typing exists for
 * the handler author; `runStartOperation` re-establishes it at runtime by
 * parsing, so erasing it here is safe.
 */
type ErasedOperationHandlerEntry = {
  run: (context: OperationHandlerContext, input: unknown) => Promise<unknown>;
  readPolicy?: "context" | "strong";
  input?: z.ZodType;
  output?: z.ZodType | ((input: unknown) => z.ZodType);
};

export function implementOperationDomain<
  Domain extends Record<string, OperationDomainDescriptor>,
>(
  domain: Domain,
  handlers: { [Member in keyof Domain]: OperationHandlerEntry<Domain[Member]> },
): {
  operations: { readonly [Member in keyof Domain]: StartOperationHandler };
} {
  const operations: Record<string, StartOperationHandler> = {};
  for (const [member, descriptor] of Object.entries(domain)) {
    const entry = handlers[member as keyof Domain] as
      | ErasedOperationHandlerEntry
      | ErasedOperationHandlerEntry["run"]
      | undefined;
    if (!entry) throw new Error(`Missing handler for ${descriptor.id}`);
    const normalized: ErasedOperationHandlerEntry =
      typeof entry === "function" ? { run: entry } : entry;
    const { run, readPolicy, input, output } = normalized;
    operations[member] = (options) =>
      runStartOperation({
        operation: descriptor.id,
        type: descriptor.definition.kind,
        input: options.data,
        inputSchema: input ?? descriptor.definition.input,
        outputSchema: output ?? descriptor.definition.output,
        request: options.request,
        ...(readPolicy ? { readPolicy } : {}),
        run: (context, parsed) =>
          run({ ...context, signal: options.request.signal }, parsed),
      });
  }
  return {
    operations: operations as {
      [Member in keyof Domain]: StartOperationHandler;
    },
  };
}
