import type { Entity } from "@cubby/schemas/entity";
import {
  browserRoutedEntities,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CubbyRow as Row } from "../data-table/table-features";
import type { ActionVerbId } from "./action-verbs";
import type {
  EntityActionDefinition,
  EntityActionHandles,
} from "./entity-actions";
import {
  entityActionCatalogDescriptors,
  useEntityActions,
} from "./entity-actions";

interface TestRow {
  id: string;
}

const succeeds = async () => ({ success: true });

const stubHandles = (
  verb: ActionVerbId,
  run: EntityActionHandles["run"],
): EntityActionHandles => ({
  run,
  rowMenuItem: (row) => <span key={verb}>{`${verb}:${row.id}`}</span>,
  dialog: <span key={verb}>{`dialog:${verb}`}</span>,
});

describe("production entity action catalog", () => {
  const roster = (entity: Entity) =>
    entityActionCatalogDescriptors
      .filter(
        (action) =>
          action.entities.includes(entity) &&
          action.verb !== "copyCodes" &&
          action.verb !== "delete",
      )
      .map(({ verb, arity, surfaces }) => ({ verb, arity, surfaces }));

  it("derives the correct copy action for every routed entity", () => {
    const copyCodes = entityActionCatalogDescriptors.find(
      (action) => action.verb === "copyCodes",
    );
    expect(copyCodes?.entities).toEqual(shortcodeEntities);
    expect(copyCodes).toMatchObject({
      arity: "both",
      surfaces: ["row", "selection", "inspector", "detail"],
      preserveSelection: true,
    });

    for (const entity of browserRoutedEntities) {
      const copyAction = entityActionCatalogDescriptors.find(
        (action) =>
          action.entities.includes(entity) &&
          (action.verb === "copyCodes" || action.verb === "copyIdentifiers"),
      );
      expect(copyAction, `${entity} copy action`).toBeDefined();
    }
  });

  it.each(browserRoutedEntities)(
    "%s has a collision-free real action roster on every declared surface",
    (entity) => {
      const actions = entityActionCatalogDescriptors.filter((action) =>
        action.entities.includes(entity),
      );
      expect(actions.length, `${entity} action count`).toBeGreaterThan(0);

      for (const surface of [
        "row",
        "selection",
        "inspector",
        "detail",
        "palette-quick",
      ] as const) {
        const ids = actions
          .filter((action) => action.surfaces.includes(surface))
          .map((action) => action.id ?? action.verb);
        expect(new Set(ids).size, `${entity}:${surface}`).toBe(ids.length);
      }

      for (const action of actions) {
        expect(
          action.surfaces.length,
          `${entity}:${action.verb}`,
        ).toBeGreaterThan(0);
        expect(new Set(action.surfaces).size).toBe(action.surfaces.length);
        if (action.group === "destructive") {
          expect(action.verb).toBe("delete");
        }
      }
    },
  );

  it("adapts every supported lifecycle delete without inventing USDA deletion", () => {
    const deleteActions = entityActionCatalogDescriptors.filter(
      (action) => action.verb === "delete",
    );
    const deletableEntities = new Set(
      deleteActions.flatMap((action) => action.entities),
    );

    expect(deletableEntities).toEqual(
      new Set(browserRoutedEntities.filter((entity) => entity !== "usda-food")),
    );
    expect(
      deleteActions.find((action) => action.entities.includes("cookbook")),
    ).toMatchObject({
      arity: "single",
      surfaces: ["row", "selection", "inspector", "detail"],
    });
    expect(
      deleteActions.find((action) => action.entities.includes("image")),
    ).toMatchObject({ arity: "single", surfaces: ["inspector", "detail"] });
  });

  it("guards Product and Inventory memberships", () => {
    expect(roster("product")).toEqual([
      {
        verb: "addToInventory",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail", "palette-quick"],
      },
      {
        verb: "printLabels",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "setStockTracking",
        arity: "both",
        surfaces: ["selection"],
      },
    ]);
    expect(roster("inventory")).toEqual([
      {
        verb: "discard",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "moveTo",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
    ]);
    expect(roster("location")).toEqual([
      {
        verb: "printLabel",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "moveUnder",
        arity: "both",
        surfaces: ["row", "selection"],
      },
    ]);
  });

  it("guards Expense and Task memberships and order", () => {
    expect(roster("expense")).toEqual([
      {
        verb: "markPurchased",
        arity: "single",
        surfaces: ["row", "inspector", "detail"],
      },
      {
        verb: "moveToProject",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "setTrade",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "setCostType",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
    ]);
    expect(roster("task")).toEqual([
      {
        verb: "moveToProject",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "setStatus",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "setTrade",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "setDueDate",
        arity: "both",
        surfaces: ["row", "selection", "inspector", "detail"],
      },
      {
        verb: "createProjectFrom",
        arity: "both",
        surfaces: ["selection"],
      },
    ]);
  });
});

/**
 * A registry written for the resolution rules rather than for whichever verbs
 * happen to be declared today, so these stay honest as the real registry fills
 * up. Injected through `useEntityActions`' test seam.
 */
const REGISTRY: readonly EntityActionDefinition[] = [
  {
    verb: "addToInventory",
    entities: ["product"],
    arity: "both",
    use: () => stubHandles("addToInventory", succeeds),
  },
  {
    verb: "merge",
    entities: ["product", "vendor"],
    arity: "multi",
    use: () => stubHandles("merge", succeeds),
  },
  {
    verb: "discard",
    entities: ["product"],
    arity: "single",
    use: () => stubHandles("discard", succeeds),
  },
  {
    verb: "setStatus",
    entities: ["task"],
    arity: "both",
    surfaces: ["selection"],
    use: () => stubHandles("setStatus", succeeds),
  },
  {
    verb: "printLabels",
    entities: ["product"],
    arity: "both",
    // Nothing to run on this invocation — a surface that could not supply the
    // action's context.
    use: () => stubHandles("printLabels", null),
  },
];

const resolve = (entity: "product" | "vendor" | "task") =>
  renderHook(() => useEntityActions<TestRow>(entity, REGISTRY)).result;

const rowMenuText = (
  rowMenuItems: (row: TestRow) => React.ReactNode,
  id: string,
) => render(<div>{rowMenuItems({ id })}</div>).container.textContent;

describe("useEntityActions", () => {
  it("resolves only the verbs the entity declares", () => {
    const product = resolve("product");
    const vendor = resolve("vendor");

    expect(product.current.selectionActions.map((a) => a.id)).toEqual([
      "add-to-inventory",
      "merge",
    ]);
    expect(vendor.current.selectionActions.map((a) => a.id)).toEqual(["merge"]);
    expect(rowMenuText(vendor.current.rowMenuItems, "VEN-1")).toBe("");
  });

  // The guard the arity declaration exists for: a row-only verb reaching a
  // selection bar would run one product's ledger line against N products.
  it("keeps a single verb out of the selection bar", () => {
    const { current } = resolve("product");

    expect(current.selectionActions.map((a) => a.id)).not.toContain("discard");
    expect(rowMenuText(current.rowMenuItems, "PRD-1")).toContain(
      "discard:PRD-1",
    );
  });

  it("keeps a multi verb out of the row menu", () => {
    const { current } = resolve("product");

    expect(rowMenuText(current.rowMenuItems, "PRD-1")).not.toContain("merge:");
    expect(current.selectionActions.map((a) => a.id)).toContain("merge");
  });

  it("floors a multi verb at two rows, whatever it asked for", () => {
    const { current } = resolve("product");
    const byId = new Map(current.selectionActions.map((a) => [a.id, a]));

    expect(byId.get("merge")?.minSelection).toBe(2);
    expect(byId.get("add-to-inventory")?.minSelection).toBe(1);
  });

  it("honors surfaces: a selection-only verb never reaches the row menu", () => {
    const { current } = resolve("task");

    expect(current.selectionActions.map((a) => a.id)).toEqual(["set-status"]);
    expect(rowMenuText(current.rowMenuItems, "TSK-1")).toBe("");
  });

  it("normalizes selection metadata", () => {
    const run = vi.fn(succeeds);
    const registry: readonly EntityActionDefinition[] = [
      {
        verb: "duplicate",
        entities: ["product"],
        arity: "single",
        surfaces: ["selection", "inspector"],
        group: "organize",
        priority: 20,
        placement: { selection: "overflow", inspector: "secondary" },
        preserveSelection: true,
        availability: ({ rows }) =>
          rows[0]?.id === "PRD-LOCKED"
            ? { status: "disabled", reason: "Already duplicated" }
            : { status: "available" },
        use: () => stubHandles("duplicate", run),
      },
      {
        verb: "markAsStock",
        entities: ["product"],
        arity: "both",
        surfaces: ["selection", "inspector"],
        group: "primary",
        priority: 200,
        use: () => stubHandles("markAsStock", run),
      },
    ];

    const { result } = renderHook(() =>
      useEntityActions<TestRow>("product", registry),
    );
    const [stock, duplicate] = result.current.selectionActionItems;

    expect(result.current.selectionActions.map((action) => action.id)).toEqual([
      "mark-as-stock",
      "duplicate",
    ]);
    expect(stock).toMatchObject({
      surface: "selection",
      group: "primary",
      priority: 200,
      placement: "primary",
      preserveSelection: false,
    });
    expect(duplicate).toMatchObject({
      surface: "selection",
      arity: "single",
      minSelection: 1,
      maxSelection: 1,
      group: "organize",
      priority: 20,
      placement: "overflow",
      preserveSelection: true,
    });
    expect(duplicate?.availability([{ id: "PRD-LOCKED" }])).toEqual({
      status: "disabled",
      reason: "Already duplicated",
    });
    expect(
      result.current.selectionActions[1]?.availability?.([
        { original: { id: "PRD-LOCKED" } } as Row<TestRow>,
      ]),
    ).toEqual({
      status: "disabled",
      reason: "Already duplicated",
    });
    expect(result.current.selectionActions[1]?.maxSelection).toBe(1);
    expect(result.current.selectionActions[1]?.preserveSelection).toBe(true);
  });

  it("resolves inspector actions independently from detail actions", () => {
    const registry: readonly EntityActionDefinition[] = [
      {
        verb: "duplicate",
        entities: ["product"],
        arity: "single",
        surfaces: ["inspector"],
        group: "organize",
        placement: { inspector: "secondary" },
        preserveSelection: true,
        use: () => stubHandles("duplicate", succeeds),
      },
    ];

    const { result } = renderHook(() =>
      useEntityActions<TestRow>("product", registry),
    );

    expect(result.current.detailActions).toEqual([]);
    expect(result.current.inspectorActions[0]).toMatchObject({
      id: "duplicate",
      verb: "duplicate",
      surface: "inspector",
      arity: "single",
      group: "organize",
      priority: 100,
      placement: "secondary",
      preserveSelection: true,
    });
  });

  it("drops a selection action with nothing to run, keeping its row entry", () => {
    const { current } = resolve("product");

    expect(current.selectionActions.map((a) => a.id)).not.toContain(
      "print-labels",
    );
    expect(rowMenuText(current.rowMenuItems, "PRD-1")).toContain(
      "printLabels:PRD-1",
    );
  });

  it("mounts one dialog per matching definition, arity notwithstanding", () => {
    const { current } = resolve("product");

    expect(render(<div>{current.dialogs}</div>).container.textContent).toBe(
      "dialog:addToInventorydialog:mergedialog:discarddialog:printLabels",
    );
  });

  // `entity` fixes which hooks run, so swapping it would reorder them.
  it("throws if the entity changes for a mounted component", () => {
    const initialProps: { entity: "product" | "task" } = { entity: "product" };
    const { rerender } = renderHook(
      ({ entity }: { entity: "product" | "task" }) =>
        useEntityActions<TestRow>(entity, REGISTRY),
      { initialProps },
    );

    expect(() => rerender({ entity: "task" })).toThrow(
      /must be constant for a component instance/,
    );
  });
});
