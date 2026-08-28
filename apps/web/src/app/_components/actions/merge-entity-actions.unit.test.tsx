import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mergeEntityActionDefinitions } from "./merge-entity-actions";

const mocks = vi.hoisted(() => ({
  dialog: vi.fn(),
  mutateAsync: vi.fn(),
}));

vi.mock("../hooks/useActionMutation", () => ({
  useActionMutation: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
}));
vi.mock("../merge/entity-merge-dialog", () => ({
  EntityMergeDialog: (props: unknown) => {
    mocks.dialog(props);
    return null;
  },
}));
vi.mock("~/app/vendors/vendor.functions", () => ({
  vendor: { merge: { mutationOptions: {} } },
}));
vi.mock("~/app/purchases/purchase.functions", () => ({
  purchase: { merge: { mutationOptions: {} } },
}));

describe("merge entity actions", () => {
  it("uses the first selected fixed-mode row as keeper and preselects the rest", () => {
    const definition = mergeEntityActionDefinitions[0];
    const { result } = renderHook(() => definition.use());
    const run = result.current.run;
    expect(run).not.toBeNull();
    if (!run) throw new Error("Vendor Merge must expose a runner");

    act(() => {
      void run([
        { id: "VEN-KEEP", name: "Keep" },
        { id: "VEN-MERGE-1", name: "Merge one" },
        { id: "VEN-MERGE-2", name: "Merge two" },
      ]);
    });
    render(result.current.dialog);

    expect(mocks.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entity: "vendor",
        keeper: expect.objectContaining({ id: "VEN-KEEP" }),
        initialAliasIds: ["VEN-MERGE-1", "VEN-MERGE-2"],
        open: true,
      }),
    );
  });

  it("disables a mixed-vendor Purchase selection without narrowing it", () => {
    const definition = mergeEntityActionDefinitions[1];
    const { result } = renderHook(() => definition.use());
    const first = {
      id: "PUR-FIRST",
      name: "First",
      vendorId: "VEN-FIRST",
    };
    const second = {
      id: "PUR-SECOND",
      name: "Second",
      vendorId: "VEN-SECOND",
    };

    expect(
      result.current.availability?.({
        entity: "purchase",
        surface: "selection",
        rows: [first, second],
      }),
    ).toEqual({
      status: "disabled",
      reason: "Purchases must share a vendor before they can be merged.",
    });
  });
});
