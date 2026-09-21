import { allEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { z, type JSONType } from "zod";

import { entityRipple, ripple, type InvalidationTagSet } from "./cache-tags";
import type { OperationCacheTag } from "./operation-meta";

/**
 * Tag matching is prefix-only: an invalidation `I` matches a query's declared
 * tag `C` iff `I.length <= C.length` and `I` is a prefix of `C`. Every
 * invariant below is a consequence of that one rule.
 */
const isPrefixOf = (
  invalidation: readonly string[],
  candidate: readonly string[],
) =>
  invalidation.length <= candidate.length &&
  invalidation.every((part, index) => candidate[index] === part);

const show = (tag: readonly string[]) => `[${tag.join(",")}]`;

type AnyDescriptor = {
  id: string;
  definition: {
    kind: string;
    tags?: readonly OperationCacheTag[];
    invalidates?:
      | InvalidationTagSet
      | ((input: JSONType) => InvalidationTagSet);
  };
  /**
   * `buildDescriptor` puts a resolved policy on every mutation descriptor —
   * static or dynamic, it is always a function of the input. That is the one
   * handle the replay below can pull on.
   */
  invalidates?: (input: JSONType) => InvalidationTagSet;
};

const moduleExportsSchema = z.record(z.string(), z.unknown());

const isDescriptor = (
  candidate: z.input<z.ZodUnknown>,
): candidate is AnyDescriptor => {
  if (candidate === null || typeof candidate !== "object") return false;
  if (!("id" in candidate) || typeof candidate.id !== "string") return false;
  if (!("definition" in candidate)) return false;
  const { definition } = candidate;
  return (
    definition !== null &&
    typeof definition === "object" &&
    "kind" in definition &&
    typeof definition.kind === "string"
  );
};

type InvalidationPolicy = (input: JSONType) => InvalidationTagSet;

const isInvalidationPolicy = (
  policy: InvalidationTagSet | InvalidationPolicy | undefined,
): policy is InvalidationPolicy => typeof policy === "function";

/**
 * There is no runtime registry of operation descriptors — `defineOperationDomain`
 * only records mutation invalidation policies — so the catalog is reassembled by
 * eagerly loading every `*.functions.ts` module and walking its domain exports.
 */
const descriptors: ReadonlyArray<{ path: string; descriptor: AnyDescriptor }> =
  Object.entries(
    import.meta.glob("../../**/*.functions.ts", { eager: true }),
  ).flatMap(([path, module]) =>
    Object.values(moduleExportsSchema.parse(module)).flatMap((domain) => {
      const parsed = moduleExportsSchema.safeParse(domain);
      if (!parsed.success) return [];
      return Object.values(parsed.data)
        .filter(isDescriptor)
        .map((descriptor) => ({ path, descriptor }));
    }),
  );

/**
 * SOURCE-declared tags, not `meta.cacheTags`: `descriptorMeta` appends `[[entity]]`
 * for a `forEntity` descriptor, and that appended root is legitimately neither a
 * prefix nor a suffix of the entity-agnostic `["entity","list"]` it sits beside.
 */
const declaredQueryTags = descriptors.flatMap(({ descriptor }) =>
  descriptor.definition.kind === "query"
    ? [...(descriptor.definition.tags ?? [])]
    : [],
);

/**
 * The live declared-tag set is the source tags PLUS `[entity]` for every manifest
 * entity, because `forEntity(e)` appends `[[e]]` at runtime
 * (`operation-catalog.ts`, `descriptorMeta`). `entity.list` / `entity.detail`
 * therefore answer to `["wish"]`, `["ledgerParty"]`, … even though no
 * `*.functions.ts` spells those tags out.
 */
const liveDeclaredTags: readonly OperationCacheTag[] = [
  ...declaredQueryTags,
  ...allEntities.map((entity): OperationCacheTag => [entity]),
];

const invalidatesSomething = (tag: OperationCacheTag) =>
  liveDeclaredTags.some((candidate) => isPrefixOf(tag, candidate));

describe("operation cache tags", () => {
  it("invalidates field suggestions when an inheritance source changes", () => {
    for (const entity of [
      "project",
      "task",
      "purchase",
      "product",
      "productCategory",
      "expense",
    ]) {
      expect(entityRipple(entity)).toContainEqual(["ai", "suggestFields"]);
    }
  });

  it("refreshes inherited costs after a taxonomy move changes Food membership", () => {
    const tags = entityRipple("productCategory");
    for (const entity of [
      "expense",
      "project",
      "purchase",
      "householdContribution",
    ]) {
      expect(tags).toContainEqual([entity]);
    }
  });

  it("loads the whole catalog", () => {
    expect(descriptors.length).toBeGreaterThan(200);
    expect(declaredQueryTags.length).toBeGreaterThan(100);
  });

  /**
   * Invariant 1. No tag on a query is a proper prefix of a sibling tag on the
   * SAME query: invalidating the prefix already prefix-matches the longer
   * sibling, so the shorter one adds nothing and only makes the declaration read
   * as if it did. `product.search` used to declare `["product"]` alongside
   * `["product","search"]`; the only invalidation that reached the first also
   * reached the second.
   *
   * Cross-entity opt-in tags are NOT redundant and must survive:
   * `entity.graph` names `["inventory"]`, `["location"]`,
   * `["expense"]`, … precisely because a graph query wants to re-read when
   * OTHER entities move. None of those is a prefix of a sibling.
   */
  it("has no tag that is a proper prefix of a sibling", () => {
    const redundant: string[] = [];
    for (const { path, descriptor } of descriptors) {
      const tags = descriptor.definition.tags ?? [];
      for (const tag of tags)
        for (const sibling of tags)
          if (tag !== sibling && isPrefixOf(tag, sibling))
            redundant.push(
              `${descriptor.id} (${path}): ${show(tag)} subsumes ${show(sibling)}`,
            );
    }
    expect(redundant).toEqual([]);
  });

  /**
   * Invariant 2. `entity.list` is tagged `[["entity","list"]]` and `entity.detail`
   * `[["entity","detail"]]` — both entity-AGNOSTIC — so invalidating `["entity"]`
   * would nuke every list and detail query for every entity on every mutation.
   */
  it("never invalidates the bare ['entity'] root", () => {
    const offenders = [
      ...Object.entries(ripple).flatMap(([name, tags]) =>
        tags
          .filter((tag) => tag.length === 1 && tag[0] === "entity")
          .map(() => `ripple.${name}`),
      ),
      ...allEntities.flatMap((entity) =>
        entityRipple(entity)
          .filter((tag) => tag.length === 1 && tag[0] === "entity")
          .map(() => `entityRipple(${entity})`),
      ),
    ];
    expect(offenders).toEqual([]);
  });

  /**
   * Invariant 3. A tag may appear in an invalidation position only if some query
   * declares it — otherwise it is a silent no-op. This is the rule that would
   * have caught the eight dead mutation op-tags (`["product","merge"]`,
   * `["product","lookup"]`, `["product","recipe"]`, `["ingredient","merge"]`,
   * `["vendor","merge"]`, `["location","reparent"]`, `["recipe","list"]`,
   * `["recipe","cookbook"]`), each longer than any tag its target queries
   * declare. Mutation policies can only use branded `ripple.*` rows, so this
   * table-level check covers every static invalidation declaration.
   */
  it("only ever invalidates tags some query declares", () => {
    const dead: string[] = [];
    for (const [name, tags] of Object.entries(ripple))
      for (const tag of tags)
        if (!invalidatesSomething(tag))
          dead.push(`ripple.${name} -> ${show(tag)}`);
    expect(dead).toEqual([]);
  });

  /**
   * Invariant 3, at the descriptors themselves rather than at the shared table.
   * Only a STATIC `invalidates:` array is readable without calling anything;
   * function-valued policies are skipped here and picked up by invariant 4,
   * which replays them against sampled inputs.
   */
  it("only ever invalidates tags some query declares, at every descriptor", () => {
    const dead: string[] = [];
    for (const { path, descriptor } of descriptors) {
      const declared = descriptor.definition.invalidates;
      if (!declared || isInvalidationPolicy(declared)) continue;
      for (const tag of declared)
        if (!invalidatesSomething(tag))
          dead.push(`${descriptor.id} (${path}) -> ${show(tag)}`);
    }
    expect(dead).toEqual([]);
  });

  /**
   * Invariant 4. A function-valued `invalidates` names its tags only when it is
   * CALLED, which makes it invisible to the declaration checks above. The
   * registry below executes every dynamic policy; a policy with no sample entry
   * is a policy nothing checks, so the first test fails rather than skipping it.
   *
   * `entity.mutate` samples all four branches of `productWriteTags`, because the
   * two widened branches are the only place in the app where an invalidation is
   * chosen from the mutation's own payload.
   */
  const dynamicPolicyInputs = new Map<string, readonly JSONType[]>([
    [
      "entity.mutate",
      [
        // A product create naming an ingredient link AND an explicit fdc_id.
        {
          action: "create",
          entity: "product",
          data: {
            name: "Flour",
            upc: null,
            manufacturer: "generic",
            expectedQuantity: null,
            ingredientId: "ING-4K7M",
            fdc_id: 12345,
            categoryId: "CAT-2222",
          },
        },
        // The same create with the ingredient link only.
        {
          action: "create",
          entity: "product",
          data: {
            name: "Flour",
            upc: null,
            manufacturer: "generic",
            expectedQuantity: null,
            ingredientId: "ING-4K7M",
            fdc_id: null,
            categoryId: null,
          },
        },
        // A plain product create: neither link, so the narrow fan-out.
        {
          action: "create",
          entity: "product",
          data: {
            name: "Widget",
            upc: null,
            manufacturer: "generic",
            expectedQuantity: null,
            ingredientId: null,
            fdc_id: null,
            categoryId: null,
          },
        },
        // A non-product entity, which never reaches `productWriteTags`.
        { action: "create", entity: "vendor", data: { name: "Acme Supply" } },
      ],
    ],
  ]);

  const dynamicPolicies = descriptors.filter(({ descriptor }) =>
    isInvalidationPolicy(descriptor.definition.invalidates),
  );

  it("has a sampled input for every dynamic invalidation policy", () => {
    expect(dynamicPolicies.length).toBeGreaterThan(0);
    const unsampled = dynamicPolicies
      .filter(({ descriptor }) => !dynamicPolicyInputs.has(descriptor.id))
      .map(({ path, descriptor }) => `${descriptor.id} (${path})`);
    expect(unsampled).toEqual([]);
  });

  it("only ever invalidates live, non-root tags when a dynamic policy is replayed", () => {
    const dead: string[] = [];
    for (const { path, descriptor } of dynamicPolicies) {
      const policy = descriptor.invalidates;
      if (!policy) {
        dead.push(
          `${descriptor.id} (${path}) exposes no runtime invalidates()`,
        );
        continue;
      }
      const samples = dynamicPolicyInputs.get(descriptor.id) ?? [];
      samples.forEach((sample, index) => {
        const at = `${descriptor.id} sample #${index}`;
        const tags = policy(sample);
        if (tags.length === 0) dead.push(`${at} -> no tags at all`);
        for (const tag of tags) {
          if (!invalidatesSomething(tag))
            dead.push(`${at} -> ${show(tag)}, which no query declares`);
          // Invariant 2, for the tags only a call can reveal.
          if (tag.length === 1 && tag[0] === "entity")
            dead.push(`${at} -> the bare ["entity"] root`);
        }
      });
    }
    expect(dead).toEqual([]);
  });

  it("entityRipple is total and live for every manifest entity", () => {
    const dead: string[] = [];
    for (const entity of allEntities) {
      const tags = entityRipple(entity);
      expect(tags.length).toBeGreaterThan(0);
      // Stable reference — safe to pass into a hook dependency array.
      expect(entityRipple(entity)).toBe(tags);
      for (const tag of tags)
        if (!invalidatesSomething(tag))
          dead.push(`entityRipple(${entity}) -> ${show(tag)}`);
    }
    expect(dead).toEqual([]);
  });
});
