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

import type {
  MutationContract,
  OperationContract,
  OperationContractMember,
  QueryContract,
  SubscriptionContract,
} from "~/contracts/define";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  startOperationDefinitionFor,
  type StartOperationId,
} from "~/lib/start-operation-observability";
import { openWorkflowStream } from "~/lib/workflow-stream";

import {
  EMPTY_INVALIDATION_TAG_SET,
  type InvalidationTagSet,
} from "./cache-tags";
import type {
  CubbyOperationMeta,
  OperationCacheProfile,
  OperationCacheTag,
  OperationFreshnessPolicy,
} from "./operation-meta";
import {
  operationCachePolicy,
  type ResolvedOperationCachePolicy,
} from "./query-policy";
import { type StartCallOptions, startOperation } from "./start-transport";

type RawOperationValue = z.input<z.ZodUnknown>;

type OperationTransport<Input, Output> = (request: {
  operation: StartOperationId;
  input: Input;
  signal?: AbortSignal;
}) => Promise<Output>;

type SharedPolicy<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> = {
  parse?: {
    bivarianceHack(
      data: RawOperationValue,
      input: z.output<Input>,
    ): z.output<Output>;
  }["bivarianceHack"];
};

export type QueryPolicy<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = SharedPolicy<Input, Output> & {
  tags?: readonly OperationCacheTag[];
  cache?:
    | OperationCacheProfile
    | {
        bivarianceHack(
          input: z.output<Input>,
        ): OperationCacheProfile | undefined;
      }["bivarianceHack"];
};

export type MutationPolicy<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = SharedPolicy<Input, Output> & {
  invalidates?:
    | InvalidationTagSet
    | {
        bivarianceHack(input: z.output<Input>): InvalidationTagSet;
      }["bivarianceHack"];
};

/** A contract member plus the browser-only policy layered onto it. */
export type QueryDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = QueryContract<Input, Output> & QueryPolicy<Input, Output>;

export type MutationDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = MutationContract<Input, Output> & MutationPolicy<Input, Output>;

/**
 * Subscriptions carry no browser policy: there is no cache entry and no
 * `invalidates`, because a stream's writes land progressively and the call
 * site decides when the run is far enough along to re-read (usually `onDone`).
 */
export type SubscriptionDefinition<
  Input extends z.ZodTypeAny,
  Event extends z.ZodTypeAny,
> = SubscriptionContract<Input, Event>;

type AnyOperationDefinition =
  | QueryDefinition<z.ZodTypeAny, z.ZodTypeAny>
  | MutationDefinition<z.ZodTypeAny, z.ZodTypeAny>;
type AnyDefinition =
  | AnyOperationDefinition
  | SubscriptionDefinition<z.ZodTypeAny, z.ZodTypeAny>;

type PolicyFor<Member extends OperationContractMember> =
  Member extends QueryContract<infer Input, infer Output>
    ? QueryPolicy<Input, Output>
    : Member extends MutationContract<infer Input, infer Output>
      ? MutationPolicy<Input, Output>
      : never;

/** Per-member browser policy; subscription members accept none. */
export type OperationPolicies<
  Ops extends Record<string, OperationContractMember>,
> = {
  readonly [
    Name in keyof Ops as PolicyFor<Ops[Name]> extends never ? never : Name
  ]?: PolicyFor<Ops[Name]>;
};

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
  (input: RawOperationValue) => InvalidationTagSet
>();

function isCacheProfileResolver<Input extends z.ZodTypeAny>(
  policy: QueryDefinition<Input, z.ZodTypeAny>["cache"],
): policy is (input: z.output<Input>) => OperationCacheProfile | undefined {
  return typeof policy === "function";
}

function isInvalidationResolver<Input extends z.ZodTypeAny>(
  policy: MutationDefinition<Input, z.ZodTypeAny>["invalidates"],
): policy is (input: z.output<Input>) => InvalidationTagSet {
  return typeof policy === "function";
}

export const operationInvalidationTags = (
  operation: string | undefined,
  input: RawOperationValue,
): InvalidationTagSet | undefined => {
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
  invalidates(input: z.input<Input>): InvalidationTagSet;
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
   * a stream has no cache entry, and its consumer (`useBulkStream`) drives it
   * directly.
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
  policy?: ResolvedOperationCachePolicy,
): CubbyOperationMeta => {
  const meta: CubbyOperationMeta = {
    transport: "start",
    operation: id,
    observedByTransport: true,
  };
  if (entity) meta.entity = entity;
  if (definition.kind === "mutation") {
    meta.invalidates = isInvalidationResolver(definition.invalidates)
      ? EMPTY_INVALIDATION_TAG_SET
      : (definition.invalidates ?? EMPTY_INVALIDATION_TAG_SET);
    return meta;
  }

  const cacheTags: OperationCacheTag[] = [...(definition.tags ?? [])];
  if (entity) cacheTags.push([entity]);
  meta.cacheTags = cacheTags;
  const resolved = policy ?? operationCachePolicy();
  meta.cacheProfile = resolved.profile;
  if (resolved.freshness) meta.freshness = resolved.freshness;
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
      : (definition.invalidates ?? EMPTY_INVALIDATION_TAG_SET);
  };
  invalidationPolicies.set(id, (input) => {
    const parsed = definition.input.safeParse(input);
    if (!parsed.success) return EMPTY_INVALIDATION_TAG_SET;
    return isInvalidationResolver(definition.invalidates)
      ? definition.invalidates(parsed.data)
      : (definition.invalidates ?? EMPTY_INVALIDATION_TAG_SET);
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
  const staticProfile = isCacheProfileResolver(definition.cache)
    ? undefined
    : definition.cache;
  const meta = descriptorMeta(
    id,
    definition,
    entity,
    operationCachePolicy(staticProfile),
  );
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
    const profile = isCacheProfileResolver(definition.cache)
      ? definition.cache(input)
      : definition.cache;
    const resolved = operationCachePolicy(profile);
    const policy: QueryPolicy = {
      meta: descriptorMeta(id, definition, entity, resolved),
    };
    if (resolved.freshness) policy.freshness = resolved.freshness;
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

/**
 * Bind a transport-neutral contract to the browser transport, layering the
 * cache/invalidation/parse policy each member needs. The contract is the only
 * source of ids, kinds, and schemas; a policy for a member the contract does
 * not declare is a type error.
 */
export function defineOperationDomain<const Contract extends OperationContract>(
  contract: Contract,
  policies: OperationPolicies<Contract["ops"]> = {},
) {
  const policyByMember = new Map<string, object>(
    Object.entries(policies).flatMap(([name, policy]) =>
      policy ? [[name, policy] as const] : [],
    ),
  );
  // SAFETY: every entry is produced from the same contract member key and its
  // corresponding descriptor; Object.fromEntries alone erases that key/value
  // correlation from TypeScript's standard-library return type.
  return Object.fromEntries(
    Object.entries(contract.ops).map(([name, member]) => {
      const operation = startOperationDefinitionFor(
        `${contract.domain}.${name}`,
      );
      if (!operation) {
        throw new Error(
          `${contract.domain}.${name} is missing from the generated registry`,
        );
      }
      // SAFETY: `OperationPolicies` typed this member's policy against its
      // kind, so merging it onto the contract member yields that kind's
      // browser definition.
      const definition = {
        ...member,
        ...policyByMember.get(name),
      } as AnyDefinition;
      return [name, buildDescriptor({ id: operation.id, definition })];
    }),
  ) as {
    readonly [Name in keyof Contract["ops"]]: OperationDescriptorFor<
      Contract["ops"][Name]
    >;
  };
}
