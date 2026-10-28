import {
  type InfiniteData,
  infiniteQueryOptions,
  mutationOptions as tanstackMutationOptions,
  queryOptions as tanstackQueryOptions,
  type UnusedSkipTokenOptions,
  type UnusedSkipTokenInfiniteOptions,
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
import { openWorkflowStream } from "~/integrations/tanstack-query/workflow-stream";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { parseOperationInput } from "~/lib/start-operation-error";
import {
  startOperationDefinitionFor,
  type StartOperationId,
} from "~/lib/start-operation-observability";
import { unparsedStartOperationDataSchema } from "~/server/operation-runtime/start-operation.contract";

import {
  EMPTY_INVALIDATION_TAG_SET,
  ripple,
  rippleFor,
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
  /** May load schemas lazily; the call awaits it before caching the result. */
  parse?: {
    bivarianceHack(
      data: RawOperationValue,
      input: z.output<Input>,
    ): z.output<Output> | Promise<z.output<Output>>;
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

/**
 * A contract member plus the resolved browser policy layered onto it. The
 * contract's own `cache` / `invalidates` are data the catalog runtime
 * resolves into `tags`, `cache`, and `invalidates` here, so they are replaced,
 * not intersected.
 */
export type QueryDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = Omit<QueryContract<Input, Output>, "cache"> & QueryPolicy<Input, Output>;

export type MutationDefinition<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
> = Omit<MutationContract<Input, Output>, "invalidates"> &
  MutationPolicy<Input, Output>;

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

export type QueryDescriptor<
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
  ): UnusedSkipTokenInfiniteOptions<
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

export type MutationDescriptor<
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

/**
 * The descriptor for a contract member or a resolved definition. Keyed on the
 * member's kind and schemas alone, so the contract's data-only cache fields
 * never affect which descriptor a member gets.
 */
export type OperationDescriptorFor<
  Definition extends AnyDefinition | OperationContractMember,
> = Definition extends {
  kind: "query";
  input: infer Input extends z.ZodTypeAny;
  output: infer Output extends z.ZodTypeAny;
}
  ? QueryDescriptor<Input, Output>
  : Definition extends {
        kind: "mutation";
        input: infer Input extends z.ZodTypeAny;
        output: infer Output extends z.ZodTypeAny;
      }
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

const keyPayload = <Input>(
  entity: string | undefined,
  input: Input,
  omit: readonly string[] = [],
) => {
  const payload: OperationKeyPayload<Input> = {
    input: omitKeyInput(input, omit),
  };
  if (entity) payload.entity = entity;
  return payload;
};

const omitKeyInput = <Input>(input: Input, omit: readonly string[]): Input => {
  if (omit.length === 0 || typeof input !== "object" || input === null)
    return input;
  // SAFETY: `queryKeyOmit` names optional attribution keys, so the remaining
  // object is still a valid parsed input for key equality.
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !omit.includes(key)),
  ) as Input;
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
  const parse = (value: RawOperationValue, input: z.output<Input>) =>
    definition.parse
      ? definition.parse(value, input)
      : definition.output.parse(value);
  const config: Parameters<
    typeof startOperation<z.output<Input>, z.output<Output>>
  >[0] = { operation: id, kind: definition.kind, parse };
  if (entity) config.entity = entity;
  // Test seam: a bound transport answers in place of dispatch.
  if (transport)
    config.dispatch = async (input, { signal }) => ({
      ok: true,
      data: unparsedStartOperationDataSchema.parse(
        await transport({ operation: id, input, signal }),
      ),
    });
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
    call: (...args) =>
      operation.call(
        parseOperationInput(id, () => definition.input.parse(args[0])),
        args[1],
      ),
    invalidates,
    mutationOptions: (mutationOptions = {}) =>
      tanstackMutationOptions({
        ...mutationOptions,
        mutationKey: ["operation", id],
        mutationFn: (input: z.input<Input>) =>
          operation.call(
            parseOperationInput(id, () => definition.input.parse(input)),
          ),
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
    keyPayload(entity, input, definition.queryKeyOmit),
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
    call: (...args) =>
      operation.call(
        parseOperationInput(id, () => definition.input.parse(args[0])),
        args[1],
      ),
    policy: (input) => queryPolicy(definition.input.parse(input)),
    queryKey: (...args) => parsedQueryKey(definition.input.parse(args[0])),
    queryOptions: (...args) => {
      const input = definition.input.parse(args[0]);
      const policy = queryPolicy(input);
      return tanstackQueryOptions({
        queryKey: parsedQueryKey(input),
        queryFn: ({ signal, client, queryKey }) =>
          operation.call(input, {
            signal,
            ...(client.getQueryState(queryKey)?.isInvalidated
              ? { consistency: "strong" as const }
              : {}),
          }),
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
        keyPayload(entity, parsedInput, definition.queryKeyOmit),
      ];
      return infiniteQueryOptions<
        z.output<Output>,
        Error,
        InfiniteData<z.output<Output>, z.input<PageParamSchema>>,
        InfiniteOperationQueryKey<z.output<Input>>,
        z.input<PageParamSchema>
      >({
        queryKey: infiniteKey,
        queryFn: ({ pageParam, signal, client, queryKey }) =>
          operation.call(
            definition.input.parse(
              infiniteOptions.page(
                input,
                infiniteOptions.pageParamSchema.parse(pageParam),
              ),
            ),
            {
              signal,
              ...(client.getQueryState(queryKey)?.isInvalidated
                ? { consistency: "strong" as const }
                : {}),
            },
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
 * A member's contract-level `cache` / `invalidates` are unresolved data (tag
 * lists, ripple keys); the policy passed to `defineOperationDomain` carries
 * their resolved form under the same names, so drop the raw fields first.
 */
const withoutCacheData = (member: OperationContractMember): object =>
  Object.fromEntries(
    Object.entries(member).filter(
      ([field]) => field !== "cache" && field !== "invalidates",
    ),
  );

function contractPolicy(
  domain: string,
  name: string,
  member: OperationContractMember,
) {
  const operation = `${domain}.${name}`;
  if (member.kind === "subscription") {
    if ("cache" in member || "invalidates" in member)
      throw new Error(
        `${operation} is a subscription and takes no cache policy.`,
      );
    return {};
  }
  if (member.kind === "query") {
    if ("invalidates" in member)
      throw new Error(
        `${operation} is a query and cannot declare invalidates.`,
      );
    const tags = member.cache?.tags ?? [[domain, name]];
    if (
      tags.some(
        (tag) => tag.length === 0 || tag.some((part) => part.length === 0),
      )
    )
      throw new Error(`${operation} declares an invalid cache tag.`);
    return {
      tags,
      ...(member.cache?.profile === undefined
        ? {}
        : { cache: member.cache.profile }),
    };
  }
  if ("cache" in member)
    throw new Error(`${operation} is a mutation and cannot declare cache.`);
  const keys = member.invalidates ?? [];
  for (const key of keys)
    if (String(key) === "none" || !Object.hasOwn(ripple, key))
      throw new Error(
        `${operation} invalidates unknown ripple row ${JSON.stringify(key)}.`,
      );
  // A single row is its own ripple; only a combination expands read
  // dependents, matching the invalidations the generated catalogs declared.
  const [only, ...rest] = keys;
  if (only === undefined) return { invalidates: ripple.none };
  if (rest.length === 0) return { invalidates: ripple[only] };
  return { invalidates: rippleFor(keys) };
}

/**
 * Bind a contract to the browser transport. Resolve its declared cache data
 * and defaults, then layer the domain's optional input-dependent policy.
 * Callers import one typed domain module; no eager all-domain facade is needed.
 * The contract remains the authority for ids, kinds and schemas.
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
  for (const name of policyByMember.keys()) {
    const member = contract.ops[name];
    if (!member)
      throw new Error(`${contract.domain}.${name} has no contract member.`);
    if (member.kind === "subscription")
      throw new Error(
        `${contract.domain}.${name} is a subscription and takes no override.`,
      );
  }
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
        ...withoutCacheData(member),
        ...contractPolicy(contract.domain, name, member),
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
