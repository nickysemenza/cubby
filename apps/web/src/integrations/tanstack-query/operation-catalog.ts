import {
  type InfiniteData,
  infiniteQueryOptions,
  mutationOptions as tanstackMutationOptions,
  queryOptions as tanstackQueryOptions,
  type UnusedSkipTokenOptions,
  type UseInfiniteQueryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import type { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { StartOperationId } from "~/lib/start-operation-observability";
import { openWorkflowStream } from "~/lib/workflow-stream";

import type {
  CubbyOperationMeta,
  OperationCacheTag,
  OperationFreshnessPolicy,
} from "./operation-meta";
import { type StartCallOptions, startOperation } from "./start-transport";

export type OperationTransport = (request: {
  operation: StartOperationId;
  input: unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

type SharedDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = {
  input: Input;
  output: Output;
  parse?: {
    bivarianceHack(data: unknown, input: z.input<Input>): z.output<Output>;
  }["bivarianceHack"];
};

export type QueryDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = SharedDefinition<Input, Output> & {
  kind: "query";
  tags?: readonly OperationCacheTag[];
  freshness?:
    | OperationFreshnessPolicy
    | {
        bivarianceHack(
          input: z.input<Input>,
        ): OperationFreshnessPolicy | undefined;
      }["bivarianceHack"];
  persistence?:
    | "persist"
    | "memory"
    | {
        bivarianceHack(input: z.input<Input>): "persist" | "memory";
      }["bivarianceHack"];
};

export type MutationDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = SharedDefinition<Input, Output> & {
  kind: "mutation";
  invalidates?:
    | readonly OperationCacheTag[]
    | {
        bivarianceHack(input: z.input<Input>): readonly OperationCacheTag[];
      }["bivarianceHack"];
};

/**
 * A server-pushed NDJSON workflow stream: one request, many events, no cache
 * entry. The event schema is keyed `event` rather than `output` ON PURPOSE —
 * that is what keeps a subscription structurally outside
 * `implementOperationDomain`'s `OperationDomainDescriptor` (which requires
 * `definition.output` and a `"query" | "mutation"` kind), so the two server
 * tables stay separate without either one having to widen its wall.
 *
 * There is no `invalidates`: a stream's writes land progressively, so the call
 * site decides when the run is far enough along to re-read (usually `onDone`).
 */
export type SubscriptionDefinition<
  Input extends z.ZodTypeAny,
  Event extends z.ZodTypeAny,
> = {
  kind: "subscription";
  input: Input;
  event: Event;
};

type AnyOperationDefinition =
  | QueryDefinition<z.ZodTypeAny, z.ZodTypeAny>
  | MutationDefinition<z.ZodTypeAny, z.ZodTypeAny>;
type AnyDefinition =
  | AnyOperationDefinition
  | SubscriptionDefinition<z.ZodTypeAny, z.ZodTypeAny>;

export const query = <Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  definition: Omit<QueryDefinition<Input, Output>, "kind">,
): QueryDefinition<Input, Output> => ({ ...definition, kind: "query" });

export const mutation = <
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(
  definition: Omit<MutationDefinition<Input, Output>, "kind">,
): MutationDefinition<Input, Output> => ({ ...definition, kind: "mutation" });

export const subscription = <
  Input extends z.ZodTypeAny,
  Event extends z.ZodTypeAny,
>(
  definition: Omit<SubscriptionDefinition<Input, Event>, "kind">,
): SubscriptionDefinition<Input, Event> => ({
  ...definition,
  kind: "subscription",
});

type InputOf<Definition extends AnyDefinition> = z.input<Definition["input"]>;
/** Conditional so it resolves for the subscription arm too, which has none. */
type OutputOf<Definition extends AnyDefinition> = Definition extends {
  output: infer Output extends z.ZodTypeAny;
}
  ? z.output<Output>
  : never;
type InputArguments<Input> = undefined extends Input
  ? [input?: Input]
  : [input: Input];

export type OperationQueryKey<Input> = readonly [
  "operation",
  StartOperationId,
  { entity?: string; input: Input },
];
export type InfiniteOperationQueryKey<Input> = readonly [
  "operation",
  StartOperationId,
  "infinite",
  { entity?: string; input: Input },
];

export const infiniteOperationQueryKey = <Input>(
  queryKey: OperationQueryKey<Input>,
): InfiniteOperationQueryKey<Input> => [
  queryKey[0],
  queryKey[1],
  "infinite",
  queryKey[2],
];

const invalidationPolicies = new Map<
  StartOperationId,
  (input: unknown) => readonly OperationCacheTag[]
>();
const NO_POLICY_INPUT = Symbol("no-operation-policy-input");

export const operationInvalidationTags = (
  operation: string | undefined,
  input: unknown,
): readonly OperationCacheTag[] | undefined =>
  operation
    ? invalidationPolicies.get(operation as StartOperationId)?.(input)
    : undefined;

type QueryDescriptor<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = {
  readonly id: StartOperationId;
  readonly definition: QueryDefinition<Input, Output>;
  readonly meta: CubbyOperationMeta;
  policy(input: z.input<Input>): {
    meta: CubbyOperationMeta;
    freshness?: OperationFreshnessPolicy;
  };
  call(
    ...args: undefined extends z.input<Input>
      ? [input?: z.input<Input>, options?: StartCallOptions]
      : [input: z.input<Input>, options?: StartCallOptions]
  ): Promise<z.output<Output>>;
  queryKey(
    ...args: InputArguments<z.input<Input>>
  ): OperationQueryKey<z.input<Input>>;
  queryOptions(
    ...args: InputArguments<z.input<Input>>
  ): UnusedSkipTokenOptions<
    z.output<Output>,
    Error,
    z.output<Output>,
    OperationQueryKey<z.input<Input>>
  > & { queryKey: OperationQueryKey<z.input<Input>> };
  infiniteQueryOptions<PageParam = number>(
    input: z.input<Input>,
    options: {
      page: (input: z.input<Input>, pageParam: PageParam) => z.input<Input>;
      getNextPageParam: (lastPage: z.output<Output>) => PageParam | undefined;
      initialPageParam?: PageParam;
    },
  ): UseInfiniteQueryOptions<
    z.output<Output>,
    Error,
    InfiniteData<z.output<Output>, PageParam>,
    InfiniteOperationQueryKey<z.input<Input>>,
    PageParam
  > & {
    queryKey: InfiniteOperationQueryKey<z.input<Input>>;
    initialPageParam: PageParam;
  };
  forEntity(entity: string): QueryDescriptor<Input, Output>;
  withTransport(transport: OperationTransport): QueryDescriptor<Input, Output>;
};

type MutationDescriptor<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = {
  readonly id: StartOperationId;
  readonly definition: MutationDefinition<Input, Output>;
  readonly meta: CubbyOperationMeta;
  call(
    ...args: undefined extends z.input<Input>
      ? [input?: z.input<Input>, options?: StartCallOptions]
      : [input: z.input<Input>, options?: StartCallOptions]
  ): Promise<z.output<Output>>;
  mutationOptions(
    options?: Omit<
      UseMutationOptions<z.output<Output>, Error, z.input<Input>>,
      "mutationFn" | "mutationKey" | "meta"
    >,
  ): UseMutationOptions<z.output<Output>, Error, z.input<Input>>;
  invalidates(input: z.input<Input>): readonly OperationCacheTag[];
  forEntity(entity: string): MutationDescriptor<Input, Output>;
  withTransport(
    transport: OperationTransport,
  ): MutationDescriptor<Input, Output>;
};

type SubscriptionDescriptor<
  Input extends z.ZodTypeAny,
  Event extends z.ZodTypeAny,
> = {
  readonly id: StartOperationIdOfKind<"subscription">;
  readonly definition: SubscriptionDefinition<Input, Event>;
  /**
   * Opens the stream. There is no `queryOptions`/`mutationOptions` sibling:
   * a stream has no cache entry, and its consumers (`useBulkStream`,
   * `useAgentStream`) drive it directly.
   */
  open(
    ...args: undefined extends z.input<Input>
      ? [input?: z.input<Input>, options?: { signal?: AbortSignal }]
      : [input: z.input<Input>, options?: { signal?: AbortSignal }]
  ): Promise<AsyncIterable<z.output<Event>>>;
};

export type OperationDescriptorFor<Definition extends AnyDefinition> =
  Definition extends QueryDefinition<infer Input, infer Output>
    ? QueryDescriptor<Input, Output>
    : Definition extends MutationDefinition<infer Input, infer Output>
      ? MutationDescriptor<Input, Output>
      : Definition extends SubscriptionDefinition<infer Input, infer Event>
        ? SubscriptionDescriptor<Input, Event>
        : never;

const descriptorMeta = (
  id: StartOperationId,
  definition: AnyOperationDefinition,
  entity?: string,
  input: unknown | typeof NO_POLICY_INPUT = NO_POLICY_INPUT,
) => ({
  transport: "start" as const,
  operation: id,
  ...(entity ? { entity } : {}),
  observedByTransport: true,
  ...(definition.kind === "query"
    ? {
        cacheTags: [
          ...(definition.tags ?? []),
          ...(entity ? ([[entity]] as const) : []),
        ],
        persistence:
          typeof definition.persistence === "function"
            ? input === NO_POLICY_INPUT
              ? "memory"
              : (
                  definition.persistence as (
                    policyInput: unknown,
                  ) => "persist" | "memory"
                )(input)
            : (definition.persistence ?? "memory"),
        ...(() => {
          const freshness =
            typeof definition.freshness === "function"
              ? input === NO_POLICY_INPUT
                ? undefined
                : (
                    definition.freshness as (
                      policyInput: unknown,
                    ) => OperationFreshnessPolicy | undefined
                  )(input)
              : definition.freshness;
          return freshness ? { freshness } : {};
        })(),
      }
    : {
        invalidates:
          typeof definition.invalidates === "function"
            ? []
            : (definition.invalidates ?? []),
      }),
});

const keyPayload = <Input>(entity: string | undefined, input: Input) => ({
  ...(entity ? { entity } : {}),
  input,
});

function buildDescriptor<Definition extends AnyDefinition>(options: {
  id: StartOperationId;
  definition: Definition;
  entity?: string;
  transport?: OperationTransport;
}): OperationDescriptorFor<Definition> {
  const { id, definition, entity, transport } = options;
  if (definition.kind === "subscription") {
    return {
      id,
      definition,
      // The URL is derived from the operation id, so a stream cannot be
      // pointed at the wrong route: the one dispatch route resolves the id
      // against the same generated registry the descriptor was built from.
      // `kind: "mutation"` is the CLIENT-side observation bucket (perf-store
      // row + `markFreshReads()`); every workflow stream writes. The wire
      // `x-cubby-operation-kind` header is read from the registry and stays
      // "subscription".
      open: (
        input: InputOf<Definition>,
        callOptions?: { signal?: AbortSignal },
      ) =>
        openWorkflowStream({
          operation: id as StartOperationIdOfKind<"subscription">,
          kind: "mutation",
          url: `/api/workflow-stream/${id}`,
          input,
          eventSchema: definition.event,
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        }),
    } as unknown as OperationDescriptorFor<Definition>;
  }
  const operation = startOperation<InputOf<Definition>, OutputOf<Definition>>({
    operation: id,
    kind: definition.kind,
    ...(entity ? { entity } : {}),
    ...(transport
      ? {
          transport: async (input, callOptions) => ({
            ok: true as const,
            data: await transport({
              operation: id,
              input,
              signal: callOptions.signal,
            }),
          }),
        }
      : {}),
    parse: (value, input) =>
      (definition.parse
        ? definition.parse(value, input)
        : definition.output.parse(value)) as OutputOf<Definition>,
  });
  const meta = descriptorMeta(id, definition, entity);
  const common = {
    id,
    definition,
    meta,
    call: (input: InputOf<Definition>, callOptions?: StartCallOptions) =>
      operation.call(input, callOptions),
    forEntity: (nextEntity: string) =>
      buildDescriptor({ ...options, entity: nextEntity }),
    withTransport: (nextTransport: OperationTransport) =>
      buildDescriptor({ ...options, transport: nextTransport }),
  };

  if (definition.kind === "mutation") {
    const invalidates = (input: InputOf<Definition>) =>
      typeof definition.invalidates === "function"
        ? definition.invalidates(input)
        : (definition.invalidates ?? []);
    invalidationPolicies.set(id, (input) =>
      invalidates(input as InputOf<Definition>),
    );
    return {
      ...common,
      invalidates,
      mutationOptions: (mutationOptions = {}) =>
        tanstackMutationOptions({
          ...mutationOptions,
          mutationKey: ["operation", id],
          mutationFn: (input: InputOf<Definition>) => operation.call(input),
          meta: {
            ...meta,
            invalidates:
              typeof definition.invalidates === "function"
                ? []
                : (definition.invalidates ?? []),
          },
        }),
    } as unknown as OperationDescriptorFor<Definition>;
  }

  const queryKey = (input: InputOf<Definition>) =>
    ["operation", id, keyPayload(entity, input)] as const;
  const queryPolicy = (input: InputOf<Definition>) => {
    const freshness =
      typeof definition.freshness === "function"
        ? (
            definition.freshness as (
              policyInput: InputOf<Definition>,
            ) => OperationFreshnessPolicy | undefined
          )(input)
        : definition.freshness;
    return {
      meta: descriptorMeta(id, definition, entity, input),
      ...(freshness ? { freshness } : {}),
    };
  };
  return {
    ...common,
    policy: queryPolicy,
    queryKey,
    queryOptions: (input: InputOf<Definition>) =>
      tanstackQueryOptions({
        queryKey: queryKey(input),
        queryFn: ({ signal }) => operation.call(input, { signal }),
        meta: queryPolicy(input).meta,
        ...queryPolicy(input).freshness,
      }),
    infiniteQueryOptions: <PageParam = number>(
      input: InputOf<Definition>,
      infiniteOptions: {
        page: (
          input: InputOf<Definition>,
          pageParam: PageParam,
        ) => InputOf<Definition>;
        getNextPageParam: (
          lastPage: OutputOf<Definition>,
        ) => PageParam | undefined;
        initialPageParam?: PageParam;
      },
    ) =>
      infiniteQueryOptions({
        queryKey: [
          "operation",
          id,
          "infinite",
          keyPayload(entity, input),
        ] as const,
        queryFn: ({ pageParam, signal }) =>
          operation.call(infiniteOptions.page(input, pageParam as PageParam), {
            signal,
          }),
        initialPageParam:
          "initialPageParam" in infiniteOptions
            ? (infiniteOptions.initialPageParam as PageParam)
            : (0 as PageParam),
        getNextPageParam: infiniteOptions.getNextPageParam,
        meta: queryPolicy(input).meta,
        ...queryPolicy(input).freshness,
      }),
  } as unknown as OperationDescriptorFor<Definition>;
}

export function defineOperationDomain<
  const Domain extends string,
  const Definitions extends Record<string, AnyDefinition>,
>(domain: Domain, definitions: Definitions) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      const id = `${domain}.${name}` as StartOperationId;
      return [name, buildDescriptor({ id, definition })];
    }),
  ) as unknown as {
    readonly [Name in keyof Definitions]: OperationDescriptorFor<
      Definitions[Name]
    >;
  };
}
