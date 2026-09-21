import type { Entity } from "@cubby/schemas/entity";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WithEntitySearchProps } from "~/app/_components/combobox/with-search-hook";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  BulkEditDialogBody,
  bulkEditEntities,
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
  }: WithEntitySearchProps<string>) {
    return children({
      items: [{ id: "LOC-GRGE", name: "Garage" }],
      onSearchChange: vi.fn(),
      isLoading: false,
      onOpenChange: vi.fn(),
    });
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("bulkEditEntities", () => {
  it("lists exactly the entities whose manifest declares capabilities.bulkUpdate", () => {
    // A regression guard for the roster the generic `bulkEdit` verb is
    // registered against (entity-actions.tsx) — every entity here, and no
    // other, must carry a non-null `lifecycle.bulkUpdate`.
    expect([...bulkEditEntities].sort()).toEqual(
      [
        "expense",
        "ingredient",
        "location",
        "planting",
        "product",
        "task",
      ].sort(),
    );
  });
});

describe("BulkEditDialogBody", () => {
  // One dirtied field, several untouched siblings, across entities with
  // different bulk-update rosters (task's five vs. planting's three) — the
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
      fieldLabel: "trade",
      optionLabel: "Electrical & Lighting",
      expected: { trade: "electrical" },
    },
    {
      entity: "planting",
      fieldKeys: ["status", "finishedOn", "locationId"],
      item: { id: "PLT-1", name: "Tomato bed" },
      fieldLabel: "status",
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

      const input = screen.getByRole("combobox", { name: fieldLabel });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.click(screen.getByRole("option", { name: optionLabel }));

      expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Update" }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit).toHaveBeenCalledWith(expected);
    },
  );

  it.each([
    ["Use inherited", "inherit"],
    ["None", "explicit"],
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

  it("renders a nullable reference field with a search picker, and clearing it sends null", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <BulkEditDialogBody
        entity="location"
        items={[{ id: "LOC-1", name: "Bin 4" }]}
        fieldKeys={["parentId"]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        isPending={false}
        searchProviderFor={stubSearchProviderFor}
      />,
      { wrapper: harness.wrapper },
    );

    // The reference field's search-backed picker is present (the injected
    // fake `searchProviderFor` above proves this is the same search seam
    // `EntityIntentFields` wires reference fields through, not a plain select).
    const picker = screen.getByRole("combobox", { name: "Parent Location" });
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Garage" }));

    // Clear only appears once a value is selected — matching
    // `moveToProject`'s old "Clear project" affordance, now generic.
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.click(
      screen.getByRole("button", { name: "Clear Parent Location" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ parentId: null });
  });

  it("is initially quiet and disabled until at least one field is touched", () => {
    render(
      <BulkEditDialogBody
        entity="planting"
        items={[{ id: "PLT-1", name: "Tomato bed" }]}
        fieldKeys={["status", "finishedOn", "locationId"]}
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

    const checkbox = screen.getByRole("checkbox", { name: "Stock tracking" });
    fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();

    rerender(<BulkEditDialogBody key="pristine" {...props} />);

    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
