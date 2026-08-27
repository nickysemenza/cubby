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
  definition: { kind: string; tags?: readonly OperationCacheTag[] };
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
   * Invariant 1, scoped. The full rule — no tag on a query is a proper prefix of
   * a sibling tag on the same query — does not hold yet: ~95 query descriptors
   * declare both a bare entity root and a narrower op tag (`product.search` has
   * `["product"]` and `["product","search"]`), and the bare root is redundant
   * because invalidating it already prefix-matches the narrower sibling.
   * Cleaning those up means editing `*.functions.ts`, which is Wave 2's step A2.
   *
   * What IS asserted here is that the redundancy never runs deeper than that one
   * idiom: no two-or-more-segment tag subsumes a sibling. A violation of THAT
   * would be a genuine modelling mistake rather than the accepted broad-root
   * convention.
   */
  it("has no redundancy deeper than the bare-entity-root idiom", () => {
    const deep: string[] = [];
    for (const { path, descriptor } of descriptors) {
      const tags = descriptor.definition.tags ?? [];
      for (const tag of tags)
        for (const sibling of tags)
          if (tag !== sibling && tag.length > 1 && isPrefixOf(tag, sibling))
            deep.push(
              `${descriptor.id} (${path}): ${show(tag)} subsumes ${show(sibling)}`,
            );
    }
    expect(deep).toEqual([]);
  });

  it.todo(
    "no tag on a query is a proper prefix of a sibling tag (Wave 2 / step A2 drops the ~95 redundant bare roots)",
  );

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
