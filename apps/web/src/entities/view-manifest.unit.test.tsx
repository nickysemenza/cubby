import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { PROBLEM_CLASS } from "@cubby/schemas/problems";
import { recipeSourceValues } from "@cubby/schemas/recipe";
import { describe, expect, it } from "vitest";

import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  FILTER_ANY,
  FILTER_NONE,
  isMultiFilterKind,
  partitionFilterSpecs,
} from "./filters";
import {
  compileProblemFilters,
  findUnexpandedRangeFilter,
} from "./problem-filter-semantics";
import { isViewActive, viewManifest, viewsForEntity } from "./view-manifest";

type ViewFilterish = { id: string; value: string | string[] };
const entityFromKey = (value: string): Entity | undefined =>
  entitySchema.safeParse(value).data;

// A `.tsx` test, so it runs under the `ui` vitest project: cross-checking a
// view's filter ids against the manifest means importing `filter-manifest.tsx`,
// which the alias-free `unit` project can't load. `view-manifest.ts` itself
// stays alias-free regardless — that's a property of the module, not the test.

describe("view manifest", () => {
  it("only pins filters that exist as specs for the same entity", () => {
    // The whole point of a view being a declaration rather than a code path:
    // applying it must set state the table can actually round-trip through the
    // URL. A typo'd column id would set a filter no column owns — invisible,
    // and unclearable except by Reset.
    for (const [entity, views] of Object.entries(viewManifest)) {
      const parsedEntity = entityFromKey(entity);
      if (!parsedEntity) continue;
      const specIds = new Set(
        getEntityFilters(parsedEntity).map((s) => s.columnId),
      );
      for (const view of views ?? []) {
        for (const filter of view.filters) {
          expect(
            specIds.has(filter.id),
            `view "${view.id}" on "${entity}" pins unknown filter "${filter.id}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("never pins a range preset that expands to nothing", () => {
    // The silent-widening case (#785): a range spec returns an EMPTY patch for
    // any preset outside its closed set, and `buildFiltersFromManifest` merges
    // that empty patch as a no-op. The constraint vanishes and the view selects
    // every row while still looking filtered.
    //
    // `compileProblemFilters` throws on this, but only for Problem-BACKED
    // views. Every other saved view — `product/shelf-disagrees`,
    // `product/unlocated`, `unlocated-durables`, `consumed-on-projects` and the
    // rest — reaches `buildFiltersFromManifest` directly and is unprotected. So
    // ask the SAME predicate here, of the whole manifest.
    for (const [entity, views] of Object.entries(viewManifest)) {
      const parsedEntity = entityFromKey(entity);
      if (!parsedEntity) continue;
      const specs = getEntityFilters(parsedEntity);
      for (const view of views ?? []) {
        const unexpanded = findUnexpandedRangeFilter(specs, view.filters);
        // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
        expect(
          unexpanded,
          `view "${entity}/${view.id}" pins range filter "${unexpanded?.id}" = ` +
            `"${String(unexpanded?.value)}", which expands to nothing — the ` +
            "filter would be dropped and the view would match every row",
        ).toBeUndefined();
      }
    }
  });

  it("never pins a urlOnly spec", () => {
    // The subtler half of the check above: a urlOnly id passes it (the spec
    // does exist) but does nothing at runtime, because applying a view writes
    // `columnFilters` and `partitionFilterSpecs` keeps urlOnly specs out of
    // that state entirely. The view would light up its checkmark and select
    // every row. `financialTransaction/unlinked` is only correct because
    // `purchasePresence` was promoted to column-backed first.
    for (const [entity, views] of Object.entries(viewManifest)) {
      const parsedEntity = entityFromKey(entity);
      if (!parsedEntity) continue;
      const [, urlOnly] = partitionFilterSpecs(getEntityFilters(parsedEntity));
      const urlOnlyIds = new Set(urlOnly.map((spec) => spec.columnId));
      for (const view of views ?? []) {
        for (const filter of view.filters) {
          expect(
            urlOnlyIds.has(filter.id),
            `view "${view.id}" on "${entity}" pins urlOnly filter "${filter.id}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("uses ids that are unique per entity", () => {
    for (const [entity, views] of Object.entries(viewManifest)) {
      const ids = (views ?? []).map((v) => v.id);
      expect(new Set(ids).size, `duplicate view id on "${entity}"`).toBe(
        ids.length,
      );
    }
  });

  it("returns no views for an entity that declares none", () => {
    expect(viewsForEntity("vendor")).toEqual([]);
    expect(viewsForEntity(undefined)).toEqual([]);
  });
});

describe("expense views produce the filters their old tabs pinned", () => {
  const specs = getEntityFilters("expense");
  const build = (viewId: string) => {
    const view = viewsForEntity("expense").find((v) => v.id === viewId);
    if (!view) throw new Error(`no such view: ${viewId}`);
    const byId = new Map(view.filters.map((f) => [f.id, f.value]));
    return buildFiltersFromManifest(specs, (columnId) => byId.get(columnId));
  };

  it("planned pins future: true", () => {
    expect(build("planned")).toEqual({ future: true });
  });

  it("unclassified pins trade 'other' with no cost recorded", () => {
    expect(build("unclassified")).toEqual({
      trade: ["other"],
      costPresenceFilter: "none",
    });
  });

  it("unassigned pins projectPresenceFilter: none without clobbering projectId", () => {
    // The sentinel ORs with a value selection rather than narrowing it, so
    // picking a project while this view is active *widens* the result
    // ("unassigned or Kitchen") instead of producing the unsatisfiable
    // `projectId IN (…) AND projectId IS NULL` that once silently emptied the
    // table. Nothing here may reintroduce a `projectId: undefined` clobber —
    // that would discard the user's own selection, which is worse.
    const filters = build("unassigned");
    expect(filters).toEqual({ projectPresenceFilter: "none" });
    expect("projectId" in filters).toBe(false);
  });

  it("sends the sentinel through as a sentinel, never as an id", () => {
    const view = viewsForEntity("expense").find((v) => v.id === "unassigned");
    expect(view?.filters).toEqual([{ id: "projectId", value: [FILTER_NONE] }]);
  });

  it("unattached pins the existing no-purchase vendor predicate", () => {
    expect(build("unattached")).toEqual({ vendorPresenceFilter: "none" });
    const view = viewsForEntity("expense").find((v) => v.id === "unattached");
    expect(view?.filters).toEqual([{ id: "purchaseId", value: [FILTER_NONE] }]);
  });

  it("unknown-quantities pins the two presence sentinels plus already-made", () => {
    // `productQuantityPresenceFilter: none` is the whole point — a *bound*
    // (`productQuantityMin/Max`) would silently exclude the null rows this view
    // exists to find, since a comparison against NULL is never true.
    expect(build("unknown-quantities")).toEqual({
      productPresenceFilter: "has",
      productQuantityPresenceFilter: "none",
      future: false,
    });
  });

  it("unknown-quantities narrows by product presence rather than line taxonomy", () => {
    // Guards the reasoning in the view's comment: `product: has` is what makes
    // the lineKind/lineBasis/costType trio redundant here. If a non-principal
    // line ever becomes able to carry a product, this view starts selecting
    // rows a quantity can't describe — and this assertion is the note saying so.
    const view = viewsForEntity("expense").find(
      (candidate) => candidate.id === "unknown-quantities",
    );
    const ids = (view?.filters ?? []).map((filter) => filter.id);
    expect(ids).toEqual(["productId", "productQuantity", "future"]);
  });

  it("reveals the column it exists to have you edit", () => {
    const view = viewsForEntity("expense").find(
      (candidate) => candidate.id === "unknown-quantities",
    );
    expect(view?.layout?.columnVisibility).toEqual({ productQuantity: true });
  });
});

describe("project and task saved views use ordinary server filters", () => {
  const build = (entity: "project" | "task", viewId: string) => {
    const view = viewsForEntity(entity).find(
      (candidate) => candidate.id === viewId,
    );
    if (!view) throw new Error(`no such view: ${entity}/${viewId}`);
    const values = new Map(
      view.filters.map((filter) => [filter.id, filter.value]),
    );
    return buildFiltersFromManifest(getEntityFilters(entity), (columnId) =>
      values.get(columnId),
    );
  };

  it("Completed projects is exactly status done", () => {
    expect(build("project", "completed")).toEqual({ status: ["done"] });
  });

  it("Inbox tasks are open, unassigned, and parentless", () => {
    expect(build("task", "inbox")).toEqual({
      status: ["not_started", "later", "in_progress", "blocked"],
      projectPresenceFilter: "none",
      parentTaskPresenceFilter: "none",
    });
  });

  it("Completed tasks is exactly status done", () => {
    expect(build("task", "completed")).toEqual({ status: ["done"] });
  });
});

describe("settlement worklist views", () => {
  const build = (
    entity: "purchase" | "financialTransaction",
    viewId: string,
  ) => {
    const view = viewsForEntity(entity).find(
      (candidate) => candidate.id === viewId,
    );
    if (!view) throw new Error(`no such view: ${entity}/${viewId}`);
    const values = new Map(
      view.filters.map((filter) => [filter.id, filter.value]),
    );
    return buildFiltersFromManifest(getEntityFilters(entity), (columnId) =>
      values.get(columnId),
    );
  };

  it("unsettled purchases is exactly the settlement_reference gap", () => {
    // NOT `financialTransactionPresenceFilter: none`. The gap is narrower: it
    // wants a POSTED transaction of a settlement kind that carries a sourceRef
    // or sits on a cash account, so a purchase with an expected refund or an
    // evidence-free row still shows up here.
    expect(build("purchase", "unsettled")).toEqual({
      dataGap: ["settlement_reference"],
    });
  });

  it("outstanding transactions are the two pre-posted statuses", () => {
    expect(build("financialTransaction", "outstanding")).toEqual({
      status: ["expected", "pending"],
    });
  });

  it("unlinked transactions pin the purchase presence sentinel", () => {
    expect(build("financialTransaction", "unlinked")).toEqual({
      purchasePresenceFilter: "none",
    });
  });
});

describe("isViewActive", () => {
  const view = {
    id: "v",
    label: "V",
    description: "",
    filters: [{ id: "trade", value: ["other"] }],
    sort: [{ id: "date", desc: false }],
  };

  it("matches identical filter and sort state", () => {
    expect(
      isViewActive(
        view,
        [{ id: "trade", value: ["other"] }],
        [{ id: "date", desc: false }],
      ),
    ).toBe(true);
  });

  it("drops the checkmark when a filter is edited by hand", () => {
    expect(
      isViewActive(
        view,
        [{ id: "trade", value: ["labor"] }],
        [{ id: "date", desc: false }],
      ),
    ).toBe(false);
  });

  it("drops the checkmark when an extra filter is added", () => {
    expect(
      isViewActive(
        view,
        [
          { id: "trade", value: ["other"] },
          { id: "future", value: "true" },
        ],
        [{ id: "date", desc: false }],
      ),
    ).toBe(false);
  });

  it("drops the checkmark when the sort is changed", () => {
    expect(
      isViewActive(
        view,
        [{ id: "trade", value: ["other"] }],
        [{ id: "date", desc: true }],
      ),
    ).toBe(false);
  });

  it("ignores sort for a view that doesn't pin one", () => {
    const noSort = { ...view, sort: undefined };
    expect(
      isViewActive(
        noSort,
        [{ id: "trade", value: ["other"] }],
        [{ id: "name", desc: true }],
      ),
    ).toBe(true);
  });
});

/**
 * A view's filter value has to be shaped the way `decodeFilters` shapes the
 * same filter from a URL — array for a multi kind, bare string otherwise.
 *
 * Get it wrong and the view still *applies* (the expanders normalize via
 * `single()`), but `isViewActive` compares by identity, so the checkmark never
 * lights and the view looks broken while working. That asymmetry is exactly
 * why this is asserted rather than eyeballed.
 */
describe("view filter values match the shape decodeFilters produces", () => {
  it.each(
    Object.entries(viewManifest).flatMap(([entity, views]) =>
      (views ?? []).flatMap((view) =>
        view.filters.map(
          (filter) =>
            [entity, view.id, filter] satisfies [string, string, ViewFilterish],
        ),
      ),
    ),
  )("%s / %s — %o", (entity, _viewId, filter) => {
    const parsedEntity = entityFromKey(entity);
    if (!parsedEntity) return;
    const spec = getEntityFilters(parsedEntity).find(
      (candidate) => candidate.columnId === filter.id,
    );
    expect(spec, `no filter spec for ${filter.id}`).toBeDefined();
    if (!spec) return;
    expect(Array.isArray(filter.value)).toBe(isMultiFilterKind(spec.kind));
  });
});

/**
 * A view that selects on a column the table hides by default must reveal it —
 * otherwise it lands the operator on a filtered list with nothing on screen
 * explaining why those rows are there.
 */
describe("views reveal the columns they select on", () => {
  it("turns on Expected and Variance for the products worklists", () => {
    const productViews = viewManifest.product ?? [];
    const shelfDisagrees = productViews.find((v) => v.id === "shelf-disagrees");
    expect(shelfDisagrees?.layout?.columnVisibility).toEqual({
      ledgerExpectedQuantity: true,
      quantityVariance: true,
      servingAsLocations: true,
    });

    for (const view of productViews) {
      for (const filter of view.filters) {
        expect(
          view.layout?.columnVisibility?.[filter.id],
          `${view.id} filters on ${filter.id} without revealing it`,
        ).toBe(true);
      }
    }
  });
});

/**
 * `unlocated`, `unlocated-durables` and `consumed-on-projects` answer the same
 * question at three widths, and the narrow ones are only trustworthy as
 * shortcuts if each is a strict narrowing rather than a second,
 * independently-drifting definition. Asserting the superset relation is what
 * keeps them from diverging: edit the broad view's predicate and this fails
 * until both narrow ones follow.
 */
describe("the unlocated views stay one question at three widths", () => {
  const productViews = viewManifest.product ?? [];
  const broad = productViews.find((v) => v.id === "unlocated");
  const durables = productViews.find((v) => v.id === "unlocated-durables");
  const consumed = productViews.find((v) => v.id === "consumed-on-projects");

  // Presence has three forms — stock on a shelf, the bin itself, and stock held
  // by a kit's parts — and "nowhere" has to mean none of them.
  // `servingAsLocations: none` is what keeps this disjoint from
  // `shelf-disagrees`; `components: none` is what keeps a decomposed kit out,
  // since its shelf claim moved to parts that match this view on their own.
  it("selects on expected-quantity, ALL THREE kinds of presence, and undecided stock tracking", () => {
    expect(broad?.filters).toEqual([
      { id: "ledgerExpectedQuantity", value: "positive" },
      { id: "location", value: [FILTER_NONE] },
      { id: "servingAsLocations", value: "none" },
      { id: "stockTracked", value: "none" },
      { id: "components", value: "none" },
    ]);
  });

  it("cannot overlap shelf-disagrees", () => {
    const disagrees = productViews.find((v) => v.id === "shelf-disagrees");
    expect(disagrees?.filters).toContainEqual({
      id: "quantityVariance",
      value: "mismatched",
    });
    expect(broad?.filters).toContainEqual({
      id: "servingAsLocations",
      value: "none",
    });
    expect(broad?.filters).toContainEqual({
      id: "location",
      value: [FILTER_NONE],
    });
  });

  it("narrows the broad view rather than restating it", () => {
    expect(broad).toBeDefined();
    for (const narrow of [durables, consumed]) {
      expect(narrow).toBeDefined();
      for (const filter of broad?.filters ?? []) {
        expect(
          narrow?.filters,
          `${narrow?.id} dropped ${filter.id}`,
        ).toContainEqual(filter);
      }
      expect(narrow?.filters.length).toBe((broad?.filters.length ?? 0) + 1);
    }
  });

  it("consumed-on-projects narrows by project presence, using the sentinel", () => {
    expect(consumed?.filters).toContainEqual({
      id: "related:product.projects",
      value: [FILTER_ANY],
    });
    expect(
      buildFiltersFromManifest(getEntityFilters("product"), (columnId) =>
        columnId === "related:product.projects" ? [FILTER_ANY] : undefined,
      ),
    ).toEqual({ projectPresenceFilter: "has" });
  });

  it("reveals the related column it filters on", () => {
    expect(
      consumed?.layout?.columnVisibility?.["related:product.projects"],
    ).toBe(true);
  });

  it("decides nothing on its own", () => {
    // It is a sorting aid over an evidence signal, not a verdict: project
    // attachment is true of consumed material AND of durables bought for a
    // project, so the row must still leave only when `stockTracked` is answered
    // or inventory appears. Pinning anything else here would make the view an
    // authority it has no basis to be.
    expect(consumed?.problem).toBeUndefined();
    expect(consumed?.filters).toContainEqual({
      id: "stockTracked",
      value: "none",
    });
  });

  it("never reveals Variance, which is `—` for every row it selects", () => {
    for (const view of [broad, durables, consumed]) {
      expect(view?.layout?.columnVisibility?.quantityVariance).toBeUndefined();
    }
  });
});

describe("problem-backed views", () => {
  const backed = Object.entries(viewManifest).flatMap(([entity, views]) =>
    (views ?? [])
      .filter((view) => view.problem)
      .flatMap((view) => {
        const parsedEntity = entityFromKey(entity);
        return parsedEntity ? [{ entity: parsedEntity, view }] : [];
      }),
  );

  it.each(backed)(
    "$entity/$view.id resolves to the canonical Problem assembly",
    ({ entity, view }) => {
      // The table and Problem runner start from exactly the same assembly. The
      // UI compiler and server-safe compiler must therefore agree without a
      // second `serverFilters` declaration that could drift.
      const values = new Map(view.filters.map((f) => [f.id, f.value]));
      expect(
        buildFiltersFromManifest(getEntityFilters(entity), (columnId) =>
          values.get(columnId),
        ),
      ).toEqual(compileProblemFilters(entity, view.filters));
    },
  );

  it("never pins a filter the repo layer would receive unresolved", () => {
    // Server workflows resolve public shortcodes into uuids in their list
    // callback BEFORE the repo sees them (`resolveLocationId` in
    // routers/inventory.ts is the canonical example). The Problems service
    // calls the repo list functions directly, on one pinned connection, so it
    // skips that step — which is fine only while no view declares an id filter.
    //
    // A view that pinned `locationIdFilter` would hand a `LOC-` code to code
    // expecting a uuid: it would match nothing and the section would silently
    // read zero. Fail here instead, loudly, at the moment someone declares one.
    for (const { entity, view } of backed) {
      for (const field of Object.keys(
        compileProblemFilters(entity, view.filters),
      )) {
        expect(
          /Id$|IdFilter$/.test(field),
          `view "${entity}/${view.id}" pins "${field}", which the repo expects already resolved — teach the service to resolve it first`,
        ).toBe(false);
      }
    }
  });
});

describe("recipe/no-instructions names the source complement", () => {
  it("excludes exactly Book and Notion, by naming everything else", () => {
    // A filter can include, never exclude, so the detector's
    // `SourceType IS DISTINCT FROM 'Book' AND IS DISTINCT FROM 'Notion'` is
    // spelled as a positive list plus the `(none)` sentinel for the nullable
    // column. That is equivalent TODAY and silently stops being equivalent the
    // moment a fifth source is added — the new one would be excluded from the
    // worklist without anything failing. This is the thing that fails.
    const view = viewsForEntity("recipe").find(
      (candidate) => candidate.id === "no-instructions",
    );
    const named = view?.filters.find((f) => f.id === "sourceType")?.value;
    expect(Array.isArray(named)).toBe(true);
    const values = Array.isArray(named)
      ? named.filter(
          (value): value is string =>
            typeof value === "string" && value !== FILTER_NONE,
        )
      : [];
    expect(new Set(values)).toEqual(
      new Set(recipeSourceValues.filter((v) => v !== "Book" && v !== "Notion")),
    );
  });
});

describe("optional scratch views", () => {
  it.each([
    {
      entity: "recipe",
      id: "no-instructions",
      key: "recipesWithoutInstructions",
    },
    { entity: "meal", id: "empty-cooked", key: "emptyCookedMeals" },
  ] as const)(
    "keeps $entity/$id without a Problem or count",
    ({ entity, id, key }) => {
      const view = viewsForEntity(entity).find(
        (candidate) => candidate.id === id,
      );
      expect(view).toBeDefined();
      expect(view?.filters.length).toBeGreaterThan(0);
      expect(view?.problem).toBeUndefined();
      expect(Object.hasOwn(PROBLEM_CLASS, key)).toBe(false);
    },
  );
});
