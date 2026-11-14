/**
 * ADR 0029 section 2's build-time rules: the production module list must
 * build, and a second writer of a column, a `fields` scope claiming another
 * reconciler's column, or a read-write cycle between scope kinds must fail.
 */
import { describe, expect, it } from "vitest";

import { defineReconciler, source, writes, type Reconciler } from "./define";
import { KERNEL_MODULES } from "./modules";
import {
  buildRegistry,
  KernelGraphError,
  validateKernelGraph,
  validateKernelReadKeys,
} from "./registry";
import {
  fixtureCharge,
  fixturePurchase,
  fixtureReceipt,
} from "./testing/kernel.fixtures";

const reconciler = (
  scope: string,
  declared: Pick<Parameters<typeof defineReconciler>[0], "reads" | "writes">,
): Reconciler =>
  defineReconciler({
    scope,
    lane: "catalog",
    version: 1,
    ...declared,
    load: async () => new Map(),
    reconcile: (_input, c) => c.done(),
  });

describe("kernel graph", () => {
  it("builds the production module list", () => {
    expect(() => buildRegistry(KERNEL_MODULES)).not.toThrow();
  });

  it("rejects table-wide dependencies on every reconciled table", () => {
    const registry = buildRegistry(KERNEL_MODULES);
    const reconcilers = [...registry.reconcilers.values()];
    const tables = new Set(
      reconcilers.flatMap((reconciler) =>
        reconciler.writes.map((target) => target.name),
      ),
    );
    for (const table of tables)
      expect(() =>
        validateKernelReadKeys(reconcilers, [`table:${table}`]),
      ).toThrow("Table-wide dependency");
  });

  it("rejects two reconcilers writing one column", () => {
    expect(() =>
      validateKernelGraph([
        reconciler("first", {
          reads: [],
          writes: [writes(fixturePurchase, ["merchant"])],
        }),
        reconciler("second", {
          reads: [],
          writes: [writes(fixturePurchase, ["merchant"])],
        }),
      ]),
    ).toThrow(
      new KernelGraphError(
        "Reconcilers first and second both write FixturePurchase.merchant",
      ),
    );
  });

  it("rejects a fields scope claiming a column another reconciler owns", () => {
    expect(() =>
      validateKernelGraph([
        reconciler("purchaseEvent", {
          reads: [],
          writes: [writes(fixturePurchase, ["category"])],
        }),
        reconciler("fields", {
          reads: [],
          writes: [writes(fixturePurchase, ["category"])],
        }),
      ]),
    ).toThrow(
      new KernelGraphError(
        "The fields scope claims FixturePurchase.category, which purchaseEvent owns",
      ),
    );
  });

  it("rejects a read-write cycle between scope kinds", () => {
    expect(() =>
      validateKernelGraph([
        reconciler("charges", {
          reads: [source.table(fixtureReceipt, ["merchant"])],
          writes: [writes(fixtureCharge, ["amountMinor"])],
        }),
        reconciler("receipts", {
          reads: [source.table(fixtureCharge, ["amountMinor"])],
          writes: [writes(fixtureReceipt, ["merchant"])],
        }),
      ]),
    ).toThrow(
      new KernelGraphError(
        "Read-write cycle between scope kinds: charges → receipts → charges",
      ),
    );
    const historyReader = defineReconciler({
      scope: "catalog-history",
      lane: "catalog",
      version: 1,
      reads: [source.history(fixtureCharge, ["amountMinor"])],
      writes: [writes(fixturePurchase, ["merchant"])],
      load: async () => new Map(),
      reconcile: (_input, c) => c.done(),
    });
    const money = defineReconciler({
      scope: "money",
      lane: "money",
      version: 1,
      reads: [source.table(fixturePurchase, ["merchant"])],
      writes: [writes(fixtureCharge, ["amountMinor"])],
      load: async () => new Map(),
      reconcile: (_input, c) => c.done(),
    });
    expect(() => validateKernelGraph([historyReader, money])).not.toThrow();
    expect(() =>
      validateKernelGraph([{ ...historyReader, lane: "money" }, money]),
    ).toThrow("Committed history sources");
    expect(() =>
      validateKernelGraph([historyReader, { ...money, lane: "catalog" }]),
    ).toThrow("Committed history sources");
  });
});
