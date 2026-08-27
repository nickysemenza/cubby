import { allEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { entityRipple, ripple } from "./cache-tags";
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
      | readonly OperationCacheTag[]
      | ((input: never) => readonly OperationCacheTag[]);
  };
};

/**
 * There is no runtime registry of operation descriptors — `defineOperationDomain`
 * only records mutation invalidation policies — so the catalog is reassembled by
 * eagerly loading every `*.functions.ts` module and walking its domain exports.
 */
const descriptors: ReadonlyArray<{ path: string; descriptor: AnyDescriptor }> =
  Object.entries(
    import.meta.glob("../../**/*.functions.ts", { eager: true }),
  ).flatMap(([path, module]) =>
    Object.values(module as Record<string, unknown>).flatMap((domain) =>
      domain && typeof domain === "object"
        ? Object.values(domain as Record<string, unknown>)
            .filter(
              (member): member is AnyDescriptor =>
                !!member &&
                typeof member === "object" &&
                "id" in member &&
                "definition" in member,
            )
            .map((descriptor) => ({ path, descriptor }))
        : [],
    ),
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
   * `product.relationshipRoute` names `["inventory"]`, `["location"]`,
   * `["expense"]`, … precisely because a product query wants to re-read when
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
   * declare. Those live in `*.functions.ts` `invalidates:` positions, which
   * Wave 2's step A2 replaces with the `ripple.*` rows asserted here; the
   * repo-wide version of this check lands as `check-invalidation-authority.ts`.
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
   * A STATIC `invalidates:` array is checkable here; the one dynamic policy
   * (`entity.mutate`) is covered by the `entityRipple` case below, which walks
   * every manifest entity it can be called with.
   */
  it("only ever invalidates tags some query declares, at every descriptor", () => {
    const dead: string[] = [];
    for (const { path, descriptor } of descriptors) {
      const declared = descriptor.definition.invalidates;
      if (!declared || typeof declared === "function") continue;
      for (const tag of declared)
        if (!invalidatesSomething(tag))
          dead.push(`${descriptor.id} (${path}) -> ${show(tag)}`);
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
