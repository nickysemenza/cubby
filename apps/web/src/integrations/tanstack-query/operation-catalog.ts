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
import {
  startOperationDefinitionFor,
  type StartOperationId,
} from "~/lib/start-operation-observability";
import { openWorkflowStream } from "~/lib/workflow-stream";

import type {
  CubbyOperationMeta,
  OperationCacheTag,
  OperationFreshnessPolicy,
} from "./operation-meta";
import { type StartCallOptions, startOperation } from "./start-transport";

type RawOperationValue = z.input<z.ZodUnknown>;

type OperationTransport<Input, Output> = (request: {
  operation: StartOperationId;
  input: Input;
  signal?: AbortSignal;
}) => Promise<Output>;

type SharedDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = {
  input: Input;
  output: Output;
  parse?: {
    bivarianceHack(
      data: RawOperationValue,
      input: z.output<Input>,
    ): z.output<Output>;
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
          input: z.output<Input>,
        ): OperationFreshnessPolicy | undefined;
      }["bivarianceHack"];
  persistence?:
    | "persist"
    | "memory"
    | {
        bivarianceHack(input: z.output<Input>): "persist" | "memory";
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
        bivarianceHack(input: z.output<Input>): readonly OperationCacheTag[];
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

const isOperationQueryPayload = (
  value: unknown,
): value is { entity?: string; input: unknown } =>
  value !== null &&
  typeof value === "object" &&
  "input" in value &&
  (!("entity" in value) ||
    value.entity === undefined ||
    typeof value.entity === "string");

export const isOperationQueryKey = (
  queryKey: readonly unknown[],
): queryKey is OperationQueryKey<unknown> => {
  const operation = queryKey[1];
  return (
    queryKey.length === 3 &&
    queryKey[0] === "operation" &&
    typeof operation === "string" &&
    startOperationDefinitionFor(operation) !== undefined &&
    isOperationQueryPayload(queryKey[2])
  );
};

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
  (input: RawOperationValue) => readonly OperationCacheTag[]
>();
const NO_POLICY_INPUT = Symbol("no-operation-policy-input");

function isFreshnessResolver<Input extends z.ZodTypeAny>(
  policy: QueryDefinition<Input, z.ZodTypeAny>["freshness"],
): policy is (input: z.output<Input>) => OperationFreshnessPolicy | undefined {
  return typeof policy === "function";
}

function isPersistenceResolver<Input extends z.ZodTypeAny>(
  policy: QueryDefinition<Input, z.ZodTypeAny>["persistence"],
): policy is (input: z.output<Input>) => "persist" | "memory" {
  return typeof policy === "function";
}

function isInvalidationResolver<Input extends z.ZodTypeAny>(
  policy: MutationDefinition<Input, z.ZodTypeAny>["invalidates"],
): policy is (input: z.output<Input>) => readonly OperationCacheTag[] {
  return typeof policy === "function";
}

export const operationInvalidationTags = (
  operation: string | undefined,
  input: RawOperationValue,
): readonly OperationCacheTag[] | undefined => {
  if (!operation) return undefined;
  const definition = startOperationDefinitionFor(operation);
  return definition
    ? invalidationPolicies.get(definition.id)?.(input)
    : undefined;
};

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
  ): OperationQueryKey<z.output<Input>>;
  queryOptions(
    ...args: InputArguments<z.input<Input>>
  ): UnusedSkipTokenOptions<
    z.output<Output>,
    Error,
    z.output<Output>,
    OperationQueryKey<z.output<Input>>
  > & { queryKey: OperationQueryKey<z.output<Input>> };
  infiniteQueryOptions<PageParamSchema extends z.ZodTypeAny>(
    input: z.input<Input>,
    options: {
      pageParamSchema: PageParamSchema;
      page: (
        input: z.input<Input>,
        pageParam: z.output<PageParamSchema>,
      ) => z.input<Input>;
      getNextPageParam: (
        lastPage: z.output<Output>,
      ) => z.input<PageParamSchema> | undefined;
      initialPageParam: z.input<PageParamSchema>;
    },
  ): UseInfiniteQueryOptions<
    z.output<Output>,
    Error,
    InfiniteData<z.output<Output>, z.input<PageParamSchema>>,
    InfiniteOperationQueryKey<z.output<Input>>,
    z.input<PageParamSchema>
  > & {
    queryKey: InfiniteOperationQueryKey<z.output<Input>>;
    initialPageParam: z.input<PageParamSchema>;
  };
  forEntity(entity: string): QueryDescriptor<Input, Output>;
  withTransport(
    transport: OperationTransport<z.output<Input>, z.output<Output>>,
  ): QueryDescriptor<Input, Output>;
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
    transport: OperationTransport<z.output<Input>, z.output<Output>>,
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
    input: z.input<Input>,
    options?: { signal?: AbortSignal },
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

const descriptorMeta = <
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(
  id: StartOperationId,
  definition:
    | QueryDefinition<Input, Output>
    | MutationDefinition<Input, Output>,
  entity?: string,
  input: z.output<Input> | typeof NO_POLICY_INPUT = NO_POLICY_INPUT,
): CubbyOperationMeta => {
  const meta: CubbyOperationMeta = {
    transport: "start",
    operation: id,
    observedByTransport: true,
  };
  if (entity) meta.entity = entity;
  if (definition.kind === "mutation") {
    meta.invalidates = isInvalidationResolver(definition.invalidates)
      ? []
      : (definition.invalidates ?? []);
    return meta;
  }

  const cacheTags: OperationCacheTag[] = [...(definition.tags ?? [])];
  if (entity) cacheTags.push([entity]);
  meta.cacheTags = cacheTags;
  meta.persistence = isPersistenceResolver(definition.persistence)
    ? input === NO_POLICY_INPUT
      ? "memory"
      : definition.persistence(input)
    : (definition.persistence ?? "memory");
  const freshness = isFreshnessResolver(definition.freshness)
    ? input === NO_POLICY_INPUT
      ? undefined
      : definition.freshness(input)
    : definition.freshness;
  if (freshness) meta.freshness = freshness;
  return meta;
};

type OperationKeyPayload<Input> = { entity?: string; input: Input };

const keyPayload = <Input>(entity: string | undefined, input: Input) => {
  const payload: OperationKeyPayload<Input> = { input };
  if (entity) payload.entity = entity;
  return payload;
};

function isSubscriptionOperationId(
  id: StartOperationId,
): id is StartOperationIdOfKind<"subscription"> {
  return startOperationDefinitionFor(id)?.kind === "subscription";
}

type OperationBuildOptions<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
  Definition extends
    | QueryDefinition<Input, Output>
    | MutationDefinition<Input, Output>,
> = {
  id: StartOperationId;
  definition: Definition;
  entity?: string;
  transport?: OperationTransport<z.output<Input>, z.output<Output>>;
};

function catalogOperation<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(
  options: OperationBuildOptions<
    Input,
    Output,
    QueryDefinition<Input, Output> | MutationDefinition<Input, Output>
  >,
) {
  const { id, definition, entity, transport } = options;
  const config: Parameters<
    typeof startOperation<z.output<Input>, z.output<Output>>
  >[0] = {
    operation: id,
    kind: definition.kind,
    parse: (value, input) =>
      definition.parse
        ? definition.parse(value, input)
        : definition.output.parse(value),
  };
  if (entity) config.entity = entity;
  if (transport) {
    config.transport = async (input, callOptions) => ({
      ok: true,
      data: await transport({
        operation: id,
        input,
        signal: callOptions.signal,
      }),
    });
  }
  return startOperation(config);
}

function buildSubscriptionDescriptor<
  Input extends z.ZodTypeAny,
  Event extends z.ZodTypeAny,
>(
  id: StartOperationId,
  definition: SubscriptionDefinition<Input, Event>,
): SubscriptionDescriptor<Input, Event> {
  if (!isSubscriptionOperationId(id)) {
    throw new Error(`${id} is not registered as a subscription`);
  }
  return {
    id,
    definition,
    // Every workflow stream writes, so it uses the mutation observation bucket
    // while the generated registry retains the subscription wire kind.
    open: (rawInput, callOptions) => {
      const input = definition.input.parse(rawInput);
      const streamOptions = {
        operation: id,
        kind: "mutation" as const,
        url: `/api/workflow-stream/${id}`,
        input,
        eventSchema: definition.event,
      };
      if (callOptions?.signal) {
        Object.assign(streamOptions, { signal: callOptions.signal });
      }
      return openWorkflowStream<z.output<Input>, Event>(streamOptions);
    },
  };
}

function buildMutationDescriptor<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(
  options: OperationBuildOptions<
    Input,
    Output,
    MutationDefinition<Input, Output>
  >,
): MutationDescriptor<Input, Output> {
  const { id, definition, entity } = options;
  const operation = catalogOperation(options);
  const meta = descriptorMeta(id, definition, entity);
  const invalidates = (rawInput: z.input<Input>) => {
    const input = definition.input.parse(rawInput);
    return isInvalidationResolver(definition.invalidates)
      ? definition.invalidates(input)
      : (definition.invalidates ?? []);
  };
  invalidationPolicies.set(id, (input) => {
    const parsed = definition.input.safeParse(input);
    if (!parsed.success) return [];
    return isInvalidationResolver(definition.invalidates)
      ? definition.invalidates(parsed.data)
      : (definition.invalidates ?? []);
  });
  return {
    id,
    definition,
    meta,
    call: (...args) => operation.call(definition.input.parse(args[0]), args[1]),
    invalidates,
    mutationOptions: (mutationOptions = {}) =>
      tanstackMutationOptions({
        ...mutationOptions,
        mutationKey: ["operation", id],
        mutationFn: (input: z.input<Input>) =>
          operation.call(definition.input.parse(input)),
        meta,
      }),
    forEntity: (nextEntity) =>
      buildMutationDescriptor({ ...options, entity: nextEntity }),
    withTransport: (nextTransport) =>
      buildMutationDescriptor({ ...options, transport: nextTransport }),
  };
}

function buildQueryDescriptor<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(
  options: OperationBuildOptions<Input, Output, QueryDefinition<Input, Output>>,
): QueryDescriptor<Input, Output> {
  const { id, definition, entity } = options;
  const operation = catalogOperation(options);
  const meta = descriptorMeta(id, definition, entity);
  const parsedQueryKey = (
    input: z.output<Input>,
  ): OperationQueryKey<z.output<Input>> => [
    "operation",
    id,
    keyPayload(entity, input),
  ];
  type QueryPolicy = {
    meta: CubbyOperationMeta;
    freshness?: OperationFreshnessPolicy;
  };
  const queryPolicy = (input: z.output<Input>): QueryPolicy => {
    const policy: QueryPolicy = {
      meta: descriptorMeta(id, definition, entity, input),
    };
    const freshness = isFreshnessResolver(definition.freshness)
      ? definition.freshness(input)
      : definition.freshness;
    if (freshness) policy.freshness = freshness;
    return policy;
  };
  return {
    id,
    definition,
    meta,
    call: (...args) => operation.call(definition.input.parse(args[0]), args[1]),
    policy: (input) => queryPolicy(definition.input.parse(input)),
    queryKey: (...args) => parsedQueryKey(definition.input.parse(args[0])),
    queryOptions: (...args) => {
      const input = definition.input.parse(args[0]);
      const policy = queryPolicy(input);
      return tanstackQueryOptions({
        queryKey: parsedQueryKey(input),
        queryFn: ({ signal }) => operation.call(input, { signal }),
        meta: policy.meta,
        ...policy.freshness,
      });
    },
    infiniteQueryOptions: <PageParamSchema extends z.ZodTypeAny>(
      input: z.input<Input>,
      infiniteOptions: {
        pageParamSchema: PageParamSchema;
        page: (
          input: z.input<Input>,
          pageParam: z.output<PageParamSchema>,
        ) => z.input<Input>;
        getNextPageParam: (
          lastPage: z.output<Output>,
        ) => z.input<PageParamSchema> | undefined;
        initialPageParam: z.input<PageParamSchema>;
      },
    ) => {
      const parsedInput = definition.input.parse(input);
      const policy = queryPolicy(parsedInput);
      const infiniteKey: InfiniteOperationQueryKey<z.output<Input>> = [
        "operation",
        id,
        "infinite",
        keyPayload(entity, parsedInput),
      ];
      return infiniteQueryOptions<
        z.output<Output>,
        Error,
        InfiniteData<z.output<Output>, z.input<PageParamSchema>>,
        InfiniteOperationQueryKey<z.output<Input>>,
        z.input<PageParamSchema>
      >({
        queryKey: infiniteKey,
        queryFn: ({ pageParam, signal }) =>
          operation.call(
            definition.input.parse(
              infiniteOptions.page(
                input,
                infiniteOptions.pageParamSchema.parse(pageParam),
              ),
            ),
            { signal },
          ),
        initialPageParam: infiniteOptions.initialPageParam,
        getNextPageParam: infiniteOptions.getNextPageParam,
        meta: policy.meta,
        ...policy.freshness,
      });
    },
    forEntity: (nextEntity) =>
      buildQueryDescriptor({ ...options, entity: nextEntity }),
    withTransport: (nextTransport) =>
      buildQueryDescriptor({ ...options, transport: nextTransport }),
  };
}

function buildDescriptor(options: {
  id: StartOperationId;
  definition: AnyDefinition;
}): OperationDescriptorFor<AnyDefinition> {
  const { id, definition } = options;
  if (definition.kind === "subscription") {
    return buildSubscriptionDescriptor(id, definition);
  }
  if (definition.kind === "mutation") {
    return buildMutationDescriptor({ id, definition });
  }
  return buildQueryDescriptor({ id, definition });
}

export function defineOperationDomain<
  const Domain extends string,
  const Definitions extends Record<string, AnyDefinition>,
>(domain: Domain, definitions: Definitions) {
  // SAFETY: every entry is produced from the same `definitions` key and its
  // corresponding descriptor; Object.fromEntries alone erases that key/value
  // correlation from TypeScript's standard-library return type.
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      const operation = startOperationDefinitionFor(`${domain}.${name}`);
      if (!operation) {
        throw new Error(
          `${domain}.${name} is missing from the generated registry`,
        );
      }
      const id = operation.id;
      return [name, buildDescriptor({ id, definition })];
    }),
  ) as {
    readonly [Name in keyof Definitions]: OperationDescriptorFor<
      Definitions[Name]
    >;
  };
}
