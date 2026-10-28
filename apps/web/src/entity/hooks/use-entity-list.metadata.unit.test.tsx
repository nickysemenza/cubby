import { flexRender } from "@tanstack/react-table";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { createTextColumn } from "~/entity/table/column-helpers";
import { installFeatures } from "~/features/registry";
import { FilterBar } from "~/ui/data-table/filter-bar";
import {
  barFieldFromConfig,
  type Filter,
} from "~/ui/data-table/filter-bar-core";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import type { RuntimeFilterOptions } from "~/ui/hooks/filter-option-types";

import { useEntityList } from "./use-entity-list";

// This isolated renderer bypasses the authenticated route that installs features.
installFeatures();

interface MetadataRow {
  id: string;
  name: string;
  notes: string | null;
  brandId: string;
}

const helper = createCubbyColumnHelper<MetadataRow>();
const save = async () => undefined;
const noFilters: Filter[] = [];
const ignoreFilterChange = () => undefined;
const nameEditable = { onSave: save };
const columns = createCubbyColumnCollection<MetadataRow>((add) => {
  add(createTextColumn(helper, "notes", { editable: { onSave: save } }));
  add(helper.accessor("brandId", { header: "Brand" }));
});
const buildFilters = () => ({});
const queryOptions = () => ({
  queryKey: ["test", "metadata-editor"],
  execute: async () => ({
    items: [
      {
        id: "PRD-TEST",
        name: "Example product",
        notes: "Example note",
        brandId: "VEN-22222",
      },
    ],
    meta: { hasNextPage: false, pageIndex: 0, pageSize: 25, totalCount: 1 },
  }),
});

function MetadataTable({
  filterOptions,
  field,
}: {
  filterOptions: RuntimeFilterOptions;
  field: "name" | "notes";
}) {
  const list = useEntityList<MetadataRow, Record<string, never>>({
    entity: "product",
    queryOptions,
    buildFilters,
    columns,
    nameEditable,
    filterOptions,
  });
  const table = list.workbench.table;
  const filterConfig = table
    .getAllLeafColumns()
    .find((column) => column.id === "brandId")?.columnDef.meta?.filterConfig;
  const cell = table
    .getRowModel()
    .rows[0]?.getVisibleCells()
    .find((cell) => cell.column.id === field);
  return (
    <>
      {filterConfig && (
        <FilterBar
          fields={[barFieldFromConfig("brandId", "Brand", filterConfig)]}
          filters={noFilters}
          onChange={ignoreFilterChange}
        />
      )}
      <fieldset aria-label="Record field">
        {cell && flexRender(cell.column.columnDef.cell, cell.getContext())}
      </fieldset>
    </>
  );
}

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(async () => {
  harness = createBrowserTestHarness();
  await act(async () => {
    await harness.loadRouter();
  });
});
afterEach(() => harness.dispose());

describe("list editor metadata refresh", () => {
  // A focused UI test schedules the metadata arrival exactly while a draft is
  // open: ordinary browser journeys do not control background roster timing.
  // Failure modes: roster/loading changes remount editors and lose drafts;
  // removing dependencies preserves drafts but freezes the filter's options.
  it.each(["name", "notes"] as const)(
    "retains the %s draft and focus while filter options refresh",
    async (field) => {
      const initial: RuntimeFilterOptions = {
        "reference:vendor:brandId": [
          { value: "VEN-22222", label: "Earlier maker" },
        ],
      };
      const updated: RuntimeFilterOptions = {
        "reference:vendor:brandId": [
          { value: "VEN-33333", label: "Updated maker" },
        ],
      };
      const loading: RuntimeFilterOptions = {
        "reference:vendor:brandId": {
          options: [{ value: "VEN-22222", label: "Earlier maker" }],
          isLoading: true,
          onActivate: () => undefined,
          onSearchChange: () => undefined,
        },
      };
      const { rerender } = render(
        <MetadataTable field={field} filterOptions={initial} />,
        { wrapper: harness.routerWrapper },
      );
      const recordField = within(
        screen.getByRole("group", { name: "Record field" }),
      );
      await waitFor(() =>
        expect(recordField.getByRole("button")).toBeEnabled(),
      );
      fireEvent.click(recordField.getByRole("button"));
      const input = await screen.findByRole("textbox");
      fireEvent.change(input, { target: { value: "Unfinished draft" } });
      input.focus();
      rerender(<MetadataTable field={field} filterOptions={loading} />);
      expect(input).toHaveFocus();
      expect(screen.getByRole("textbox")).toHaveValue("Unfinished draft");
      rerender(<MetadataTable field={field} filterOptions={updated} />);
      expect(input).toHaveFocus();
      expect(screen.getByRole("textbox")).toHaveValue("Unfinished draft");
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      fireEvent.click(await screen.findByRole("button", { name: "Brand" }));
      expect(
        await screen.findByRole("option", { name: "Updated maker" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("option", { name: "Earlier maker" }),
      ).not.toBeInTheDocument();
    },
  );
});
