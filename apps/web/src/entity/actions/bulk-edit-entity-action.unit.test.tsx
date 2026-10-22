import type { Entity } from "@cubby/schemas/entity";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { recipeSectionsInput } from "@cubby/schemas/recipe-fields";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SearchProviderProps } from "~/entity/picker/with-search-hook";
import { installFeatures } from "~/features/registry";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  BulkEditDialogBody,
  type BulkEditDraft,
} from "./bulk-edit-entity-action";

/**
 * Fakes the search-backed picker for every reference field in this file's
 * tests, injected through `BulkEditDialogBody`'s `searchProviderFor` prop —
 * the same seam `editable-entity-cell.unit.test.tsx` uses at the
 * `SearchProvider` prop, not a module mock. Bypasses the real query hooks
 * (which would otherwise need a live entity-list transport) and hands back a
 * fixed item synchronously, regardless of which entity is asked for.
 */
function stubSearchProviderFor() {
  return function StubSearchProvider({
    children,
  }: SearchProviderProps<string>) {
    return children({
      items: [{ id: "LOC-GRGE", name: "Garage" }],
      onSearchChange: vi.fn(),
      isLoading: false,
      onOpenChange: vi.fn(),
    });
  };
}

function purchaseSearchProviderFor() {
  return function SyntheticPurchaseSearch({
    children,
  }: SearchProviderProps<string>) {
    return children({
      items: [{ id: "PUR-ABCD", name: "Synthetic purchase" }],
      onSearchChange: vi.fn(),
      isLoading: false,
      onOpenChange: vi.fn(),
    });
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  installFeatures();
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("BulkEditDialogBody", () => {
  it("makes structured removal controls visibly distinct", () => {
    render(
      <BulkEditDialogBody
        entity="financialTransaction"
        items={[{ id: "FTX-ABCD", name: "Synthetic charge" }]}
        fieldKeys={["allocations"]}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        isPending={false}
        searchProviderFor={purchaseSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );
    const removals = within(
      screen.getByRole("group", { name: "Allocations to remove" }),
    );
    expect(removals.getByText("Allocations to remove")).toBeVisible();
    fireEvent.click(
      removals.getByRole("button", { name: "Choose item to remove" }),
    );
    expect(
      removals.getByRole("button", { name: "Cancel removal 1" }),
    ).toBeVisible();
  });
  it("stages keyed removals before additions so an existing allocation can change", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="financialTransaction"
        items={[{ id: "FTX-ABCD", name: "Synthetic charge" }]}
        fieldKeys={["allocations"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
        searchProviderFor={purchaseSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );
    for (const operation of ["add", "remove"]) {
      const group = within(
        screen.getByRole("group", { name: `Allocations to ${operation}` }),
      );
      fireEvent.click(
        group.getByRole("button", {
          name: /Add allocation|Choose item to remove/,
        }),
      );
      const purchase = group.getByRole("combobox", { name: "Purchase id" });
      purchase.focus();
      fireEvent.keyDown(purchase, { key: "ArrowDown" });
      fireEvent.change(purchase, { target: { value: "Synthetic" } });
      fireEvent.keyDown(purchase, { key: "ArrowDown" });
      fireEvent.keyDown(purchase, { key: "Enter" });
      if (operation === "add")
        fireEvent.change(group.getByLabelText("Amount"), {
          target: { value: "6" },
        });
    }
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        allocations: [
          { op: "remove", key: { purchaseId: "PUR-ABCD" } },
          { op: "add", key: { purchaseId: "PUR-ABCD" }, value: { amount: 6 } },
        ],
      }),
    );
  });
  it("normalizes cleared optional lists in structured additions", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="recipe"
        items={[{ id: "RCP-ABCD", name: "Synthetic recipe" }]}
        fieldKeys={["sections"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
        searchProviderFor={stubSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );
    const additions = within(
      screen.getByRole("group", { name: "Composition to add" }),
    );
    fireEvent.click(additions.getByRole("button", { name: "Add composition" }));
    fireEvent.click(additions.getByRole("button", { name: "Add ingredient" }));
    fireEvent.click(
      additions.getByRole("button", { name: "Remove ingredient 1" }),
    );
    fireEvent.click(additions.getByRole("button", { name: "Add instruction" }));
    fireEvent.change(additions.getByLabelText("Instruction"), {
      target: { value: "Synthetic step" },
    });
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const submitted = z
      .object({ sections: z.array(z.object({ key: z.json() })) })
      .parse(onSubmit.mock.calls[0]?.[0]);
    expect(
      recipeSectionsInput.safeParse(submitted.sections.map((item) => item.key))
        .success,
    ).toBe(true);
    expect(submitted.sections[0]?.key).toEqual(
      expect.objectContaining({
        instructions: [{ instruction: "Synthetic step" }],
      }),
    );
  });
  it("renders editable references without an explicit normal control", () => {
    render(
      <BulkEditDialogBody
        entity="recipe"
        items={[{ id: "RCP-ABCD", name: "Synthetic recipe" }]}
        fieldKeys={["cookbookId"]}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        isPending={false}
        searchProviderFor={stubSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("combobox", { name: "Cookbook" })).toBeVisible();
  });

  it("submits structured additions for financial allocations", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="financialTransaction"
        items={[{ id: "FTX-ABCD", name: "Synthetic charge" }]}
        fieldKeys={["allocations"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
        searchProviderFor={purchaseSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );
    const additions = screen.getByRole("group", { name: "Allocations to add" });
    fireEvent.click(
      within(additions).getByRole("button", { name: /Add allocation/ }),
    );
    const purchase = within(additions).getByRole("combobox", {
      name: "Purchase id",
    });
    purchase.focus();
    fireEvent.keyDown(purchase, { key: "ArrowDown" });
    fireEvent.change(purchase, { target: { value: "Synthetic" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Synthetic purchase" }),
    );
    fireEvent.change(within(additions).getByLabelText("Amount"), {
      target: { value: "6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        allocations: [
          { op: "add", key: { purchaseId: "PUR-ABCD" }, value: { amount: 6 } },
        ],
      }),
    );
  });
  it("submits list additions and removals as patches", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="product"
        items={[{ id: "PRD-ABCD", name: "Synthetic mount" }]}
        fieldKeys={["tags"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
      />,
      { wrapper: harness.wrapper },
    );
    const add = screen.getByPlaceholderText("Tags to add");
    fireEvent.change(add, { target: { value: "mount-a" } });
    fireEvent.keyDown(add, { key: "Enter" });
    const remove = screen.getByPlaceholderText("Tags to remove");
    fireEvent.change(remove, { target: { value: "mount-b" } });
    fireEvent.keyDown(remove, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        tags: [
          { op: "remove", key: "mount-b" },
          { op: "add", key: "mount-a" },
        ],
      }),
    );
  });

  it("does not turn Set value with an empty control into an accidental clear", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="expense"
        items={[{ id: "EXP-ABCD", name: "Free supplies", cost: 0 }]}
        fieldKeys={["date"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Set value" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("Enter a value for Date.")).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Date unknown" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ date: null }));
  });

  it.each([
    {
      entity: "expense" as const,
      key: "date",
      label: "Date",
      action: "Date unknown",
      item: { id: "EXP-ABCD", name: "Free supplies", cost: 0 },
    },
    {
      entity: "planting" as const,
      key: "season",
      label: "Season",
      action: "Clear",
      item: { id: "PLT-ABCD", name: "Seedlings" },
    },
    {
      entity: "location" as const,
      key: "parentId",
      label: "Parent",
      action: "Clear",
      item: { id: "LOC-ABCD", name: "Storage bin" },
    },
  ])(
    "explicitly clears an untouched $entity.$key and can return to unchanged",
    async ({ entity, key, label, action, item }) => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(
        <BulkEditDialogBody
          entity={entity}
          items={[item]}
          fieldKeys={[key]}
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          isPending={false}
          searchProviderFor={stubSearchProviderFor}
        />,
        { wrapper: harness.wrapper },
      );
      const modes = within(
        screen.getByRole("group", { name: `${label} change` }),
      );
      fireEvent.click(modes.getByRole("button", { name: action }));
      expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
      fireEvent.click(modes.getByRole("button", { name: "Leave unchanged" }));
      expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
      fireEvent.click(modes.getByRole("button", { name: action }));
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith({ [key]: null }),
      );
    },
  );

  it("does not offer unknown dates for a selection containing a paid expense", () => {
    render(
      <BulkEditDialogBody
        entity="expense"
        items={[
          { id: "EXP-ABCD", name: "Free supplies", cost: 0 },
          { id: "EXP-BCDE", name: "Paid supplies", cost: 1 },
        ]}
        fieldKeys={["date"]}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        isPending={false}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("button", { name: "Date unknown" })).toBeDisabled();
  });

  it("offers unknown dates when every selected expense is free or of unknown cost", () => {
    render(
      <BulkEditDialogBody
        entity="expense"
        items={[
          { id: "EXP-ABCD", name: "Free supplies", cost: 0 },
          { id: "EXP-BCDE", name: "Historical supplies", cost: null },
        ]}
        fieldKeys={["date"]}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        isPending={false}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("button", { name: "Date unknown" })).toBeEnabled();
  });

  // One dirtied field, several untouched siblings, across entities with
  // different bulk-update rosters — the
  // payload must carry exactly the touched key either way.
  it.each<{
    entity: Entity;
    fieldKeys: string[];
    item: { id: string; name: string };
    fieldLabel: string;
    optionLabel: string;
    expected: BulkEditDraft;
  }>([
    {
      entity: "task",
      fieldKeys: [
        ...(entityInspectorMetadata.task.lifecycle.bulkUpdate?.fields ?? []),
      ],
      item: { id: "TSK-1", name: "Hang drywall" },
      fieldLabel: "Trade",
      optionLabel: "Electrical & Lighting",
      expected: { trade: "electrical" },
    },
    {
      entity: "planting",
      fieldKeys: ["status", "season", "locationId"],
      item: { id: "PLT-1", name: "Tomato bed" },
      fieldLabel: "Status",
      optionLabel: "Finished",
      expected: { status: "finished" },
    },
  ])(
    "sends only the touched field for $entity, omitting its other bulk fields",
    async ({ entity, fieldKeys, item, fieldLabel, optionLabel, expected }) => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(
        <BulkEditDialogBody
          entity={entity}
          items={[item]}
          fieldKeys={fieldKeys}
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          isPending={false}
          searchProviderFor={stubSearchProviderFor}
        />,
        { wrapper: harness.wrapper },
      );

      const picker = screen.getByRole("combobox", { name: fieldLabel });
      picker.focus();
      fireEvent.keyDown(picker, { key: "ArrowDown" });
      const option = await screen.findByRole("option", { name: optionLabel });
      // A choose-mode picker (a button, Base UI Select) commits a click only
      // on a highlighted row; a search-mode input commits it directly.
      if (picker.tagName !== "INPUT") fireEvent.mouseMove(option);
      fireEvent.click(option);

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Update" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Update" }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit).toHaveBeenCalledWith(expected);
    },
  );

  it.each([
    ["Use inherited", "inherit"],
    ["Set to none", "explicit"],
  ])(
    "bulk project %s writes the companion mode without rendering metadata",
    async (action, mode) => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(
        <BulkEditDialogBody
          entity="task"
          items={[
            { id: "TSK-1", name: "First" },
            { id: "TSK-2", name: "Second" },
          ]}
          fieldKeys={[
            ...(entityInspectorMetadata.task.lifecycle.bulkUpdate?.fields ??
              []),
          ]}
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          isPending={false}
          searchProviderFor={stubSearchProviderFor}
        />,
        { wrapper: harness.wrapper },
      );
      fireEvent.click(
        within(
          screen.getByRole("group", { name: "Project assignment" }),
        ).getByRole("button", { name: action }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith({
          projectId: null,
          projectMode: mode,
        }),
      );
    },
  );

  it("leaves both assignment and inheritance mode unchanged after cancelling a clear", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="task"
        items={[{ id: "TSK-1", name: "Install shelf" }]}
        fieldKeys={["projectId", "projectMode", "trade"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
        searchProviderFor={stubSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );
    const modes = within(screen.getByRole("group", { name: "Project change" }));
    fireEvent.click(modes.getByRole("button", { name: "Clear" }));
    fireEvent.click(modes.getByRole("button", { name: "Leave unchanged" }));
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    const input = screen.getByRole("combobox", { name: "Trade" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.click(
      screen.getByRole("option", { name: "Electrical & Lighting" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ trade: "electrical" }),
    );
  });

  it("is initially quiet and disabled until at least one field is touched", () => {
    render(
      <BulkEditDialogBody
        entity="planting"
        items={[{ id: "PLT-1", name: "Tomato bed" }]}
        fieldKeys={["status", "season", "locationId"]}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        isPending={false}
        searchProviderFor={stubSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No changes yet")).toBeNull();
  });

  it("restores the quiet disabled state when reopening a pristine bulk form", () => {
    const props = {
      entity: "product" as const,
      items: [{ id: "PRD-1", name: "Bench vise", stockTracked: false }],
      fieldKeys: ["stockTracked"],
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      isPending: false,
    };
    const { rerender } = render(<BulkEditDialogBody key="dirty" {...props} />, {
      wrapper: harness.wrapper,
    });

    const checkbox = screen.getByRole("checkbox", { name: "Stock tracked" });
    fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();

    rerender(<BulkEditDialogBody key="pristine" {...props} />);

    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
