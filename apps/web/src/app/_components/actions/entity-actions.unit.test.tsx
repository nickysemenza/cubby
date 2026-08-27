import { render, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActionVerbId } from "./action-verbs";
import type {
  EntityActionDefinition,
  EntityActionHandles,
} from "./entity-actions";
import { useEntityActions } from "./entity-actions";

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
    surfaces: ["bar"],
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

    expect(product.current.bulkActions.map((a) => a.id)).toEqual([
      "add-to-inventory",
      "merge",
    ]);
    expect(vendor.current.bulkActions.map((a) => a.id)).toEqual(["merge"]);
    expect(rowMenuText(vendor.current.rowMenuItems, "VEN-1")).toBe("");
  });

  // The guard the arity declaration exists for: a row-only verb reaching a
  // selection bar would run one product's ledger line against N products.
  it("keeps a single verb out of the selection bar", () => {
    const { current } = resolve("product");

    expect(current.bulkActions.map((a) => a.id)).not.toContain("discard");
    expect(rowMenuText(current.rowMenuItems, "PRD-1")).toContain(
      "discard:PRD-1",
    );
  });

  it("keeps a multi verb out of the row menu", () => {
    const { current } = resolve("product");

    expect(rowMenuText(current.rowMenuItems, "PRD-1")).not.toContain("merge:");
    expect(current.bulkActions.map((a) => a.id)).toContain("merge");
  });

  it("floors a multi verb at two rows, whatever it asked for", () => {
    const { current } = resolve("product");
    const byId = new Map(current.bulkActions.map((a) => [a.id, a]));

    expect(byId.get("merge")?.minSelection).toBe(2);
    expect(byId.get("add-to-inventory")?.minSelection).toBe(1);
  });

  it("honors surfaces: a bar-only verb never reaches the row menu", () => {
    const { current } = resolve("task");

    expect(current.bulkActions.map((a) => a.id)).toEqual(["set-status"]);
    expect(rowMenuText(current.rowMenuItems, "TSK-1")).toBe("");
  });

  it("drops a bulk action with nothing to run, keeping its row entry", () => {
    const { current } = resolve("product");

    expect(current.bulkActions.map((a) => a.id)).not.toContain("print-labels");
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
