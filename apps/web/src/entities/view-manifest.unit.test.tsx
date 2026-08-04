import { describe, expect, it } from "vitest";
import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  FILTER_NONE,
  partitionFilterSpecs,
} from "./filters";
import { isViewActive, viewManifest, viewsForEntity } from "./view-manifest";

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
      const specIds = new Set(
        getEntityFilters(entity as never).map((s) => s.columnId),
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

  it("never pins a urlOnly spec", () => {
    // The subtler half of the check above: a urlOnly id passes it (the spec
    // does exist) but does nothing at runtime, because applying a view writes
    // `columnFilters` and `partitionFilterSpecs` keeps urlOnly specs out of
    // that state entirely. The view would light up its checkmark and select
    // every row. `financialTransaction/unlinked` is only correct because
    // `purchasePresence` was promoted to column-backed first.
    for (const [entity, views] of Object.entries(viewManifest)) {
      const [, urlOnly] = partitionFilterSpecs(
        getEntityFilters(entity as never),
      );
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
    expect(viewsForEntity("recipe")).toEqual([]);
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
    expect(view?.filters).toEqual([{ id: "project", value: [FILTER_NONE] }]);
  });

  it("unattached pins the existing no-purchase vendor predicate", () => {
    expect(build("unattached")).toEqual({ vendorPresenceFilter: "none" });
    const view = viewsForEntity("expense").find((v) => v.id === "unattached");
    expect(view?.filters).toEqual([{ id: "vendor", value: [FILTER_NONE] }]);
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
    // A view is a starting point, not a mode — keeping it lit while showing
    // different rows would be the dishonest readout.
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
