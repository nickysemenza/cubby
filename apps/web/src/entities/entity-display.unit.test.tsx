import type { CellData } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/app/_components/data-table/table-features";

import {
  createEntityDisplayColumns,
  EntityBasicInfo,
  entitySectionFields,
} from "./entity-display";

/**
 * Narrows a column's `cell` to a callable renderer taking only `{ row }` —
 * every plain-scalar column `createEntityDisplayColumns` builds itself.
 * Generic over `TValue` (matching `CubbyColumnDef`'s own shape) so this can
 * be called from inside a `CubbyColumnCollection.visit()` callback, where a
 * column's `cell` is typed against that one call's own captured `TValue`
 * rather than the default `CellData` — see `materializeCubbyColumns`'s doc
 * in table-features.ts on why that capture can't be widened after the fact.
 */
function isRowRenderer<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
): cell is (context: { row: { original: TRecord } }) => ReactNode {
  return typeof cell === "function";
}

function renderRowCell<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
  record: TRecord,
): ReactNode {
  if (!isRowRenderer<TRecord, TValue>(cell)) {
    throw new Error("Expected a row cell renderer.");
  }
  return cell({ row: { original: record } });
}

describe("declared entity displays", () => {
  it("selects declared detail sections without leaking overview fields", () => {
    render(
      <EntityBasicInfo
        entity="project"
        fields={entitySectionFields("project", "resources")}
        record={{
          name: "Fixture project",
          googleDriveFolderUrl: "https://example.com/folder",
          notionPageUrl: "https://example.com/page",
        }}
      />,
    );
    expect(screen.getByText("Google Drive folder")).toBeVisible();
    expect(screen.getByText("Notion page")).toBeVisible();
    expect(screen.queryByText("Name")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture project")).not.toBeInTheDocument();
  });

  it("rejects a renderer assigned to a different declared detail section", () => {
    expect(() =>
      render(
        <EntityBasicInfo
          entity="project"
          fields={entitySectionFields("project", "resources")}
          record={{ name: "Fixture project" }}
          overrides={{ name: (record) => ({ value: record.name }) }}
        />,
      ),
    ).toThrow("Undeclared detail renderer for project.name");
  });

  it("keeps computed facts next to their declared owner and permits value-dependent labels", () => {
    render(
      <EntityBasicInfo
        entity="ledgerParty"
        record={{ name: "Guest", kind: "guest", notes: "Fixture notes" }}
        overrides={{
          kind: () => ({ label: "Guest type", value: "Visitor" }),
        }}
        afterFields={{
          kind: [{ label: "Reference", value: "Computed reference" }],
        }}
      />,
    );
    const type = screen.getByText("Guest type");
    const reference = screen.getByText("Reference");
    const notes = screen.getByText("Notes");
    expect(
      type.compareDocumentPosition(reference) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      reference.compareDocumentPosition(notes) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getByText("Visitor")).toBeVisible();
    expect(screen.getByText("Computed reference")).toBeVisible();
  });
  it("rejects computed facts anchored to absent detail fields", () => {
    expect(() =>
      render(
        <EntityBasicInfo
          entity="ledgerParty"
          record={{ name: "Guest", kind: "guest", notes: null }}
          afterFields={{ absent: [{ label: "Lost fact", value: "Fixture" }] }}
        />,
      ),
    ).toThrow("Undeclared detail renderer for ledgerParty.absent");
  });
  it("rejects detail renderers that the declared detail surface would omit", () => {
    expect(() =>
      render(
        <EntityBasicInfo
          entity="ledgerParty"
          record={{ name: "Guest", kind: "guest", notes: null }}
          overrides={{ undeclared: () => ({ value: "Must remain visible" }) }}
        />,
      ),
    ).toThrow("Undeclared detail renderer for ledgerParty.undeclared");
  });
  it("rejects unmatched specialized columns instead of silently dropping them", () => {
    const helper = createCubbyColumnHelper<{ name: string }>();
    expect(() =>
      createEntityDisplayColumns(
        "ledgerParty",
        helper,
        createCubbyColumnCollection((add) => {
          add(helper.display({ id: "purchaseIdentity", cell: () => null }));
        }),
      ),
    ).toThrow("Undeclared display renderer for ledgerParty.purchaseIdentity");
  });
  it("renders declared scalar detail fields with specialized values and actions", () => {
    render(
      <EntityBasicInfo
        entity="ledgerParty"
        record={{ name: "Guest fixture", kind: "guest", notes: null }}
        overrides={{
          kind: (record) => ({
            value: <strong>{record.kind.toUpperCase()}</strong>,
            filterAction: <button>Filter guests</button>,
          }),
        }}
        actions={<button>Edit party</button>}
      />,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Guest fixture")).toBeInTheDocument();
    expect(screen.getByText("GUEST").tagName).toBe("STRONG");
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter guests" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit party" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Created At")).not.toBeInTheDocument();
  });

  it("preserves false and zero as visible values", () => {
    const { rerender } = render(
      <EntityBasicInfo
        entity="ingredient"
        record={{
          name: "Salt fixture",
          aliases: [],
          naKinds: [],
          usuallyOnHand: false,
        }}
      />,
    );
    expect(screen.getByText("No")).toBeInTheDocument();
    rerender(
      <EntityBasicInfo
        entity="vendor"
        record={{ name: "Vendor fixture", purchaseCount: 0, spend: 0 }}
      />,
    );
    expect(screen.getAllByText("0")).toHaveLength(2);
  });

  it.each([undefined, "Old local label"])(
    "derives labels for renderer header %s while preserving metadata and copy data",
    (header) => {
      type Party = { name: string; kind: string; notes: string | null };
      const helper = createCubbyColumnHelper<Party>();
      const cell = () => <strong>Linked identity</strong>;
      const columns = createEntityDisplayColumns(
        "ledgerParty",
        helper,
        createCubbyColumnCollection<Party>((add) =>
          add(
            helper.accessor("name", {
              header,
              cell,
              meta: { mobile: { slot: "title", priority: 0 } },
            }),
          ),
        ),
      );
      const row: Party = {
        name: "Guest",
        kind: "guest",
        notes: "Review these notes",
      };
      const details = columns.visit((column) => ({
        id: column.id ?? ("accessorKey" in column ? column.accessorKey : null),
        header: z.string().parse(column.header),
        cellIsOverride: column.cell === cell,
        mobile: column.meta?.mobile,
        copied: column.meta?.cellData?.getCopyPayload(row),
      }));
      expect(details.map(({ id, header }) => ({ id, header }))).toEqual([
        { id: "name", header: "Name" },
        { id: "kind", header: "Kind" },
        { id: "notes", header: "Notes" },
      ]);
      expect(details[0]).toMatchObject({
        cellIsOverride: true,
        mobile: { slot: "title", priority: 0 },
      });
      expect(details[2]?.copied).toEqual({
        text: "Review these notes",
        json: "Review these notes",
      });
    },
  );

  it("leaves standard identity rendering to the shared table without duplicating it", () => {
    const columns = createEntityDisplayColumns(
      "vendor",
      createCubbyColumnHelper<{ name: string }>(),
    );
    const ids = columns.visit((column) => column.id);
    expect(ids).not.toContain("name");
    expect(ids).not.toContain("logo");
    expect(ids).toContain("notes");
  });

  it("requires specialized columns for relations instead of exposing raw ids", () => {
    const helper = createCubbyColumnHelper<{ fromPartyId: string }>();
    expect(() => createEntityDisplayColumns("ledgerTransfer", helper)).toThrow(
      "needs a specialized column",
    );
  });

  it("preserves declared legacy column ids for specialized computed values", () => {
    const helper = createCubbyColumnHelper<{
      fromPartyId: string;
      toPartyId: string;
    }>();
    const columns = createEntityDisplayColumns(
      "ledgerTransfer",
      helper,
      createCubbyColumnCollection((add) => {
        for (const id of ["fromPartyId", "toPartyId", "evidenceCount"]) {
          add(helper.display({ id, header: "Specialized", cell: () => null }));
        }
      }),
    );
    expect(columns.visit((column) => column.id)).toContain("evidenceCount");
    expect(columns.visit((column) => column.id)).not.toContain(
      "evidenceTransactionIds",
    );
  });

  describe("declared width/format/mobile/sorting", () => {
    // Most of `product`'s `list: true` roster is plain scalars, exercised
    // here with zero overrides — the cleanest surface for the generic
    // mapping itself. Three fields still force an override regardless
    // (`dataQuality` is `kind: "json"`; `servingAsLocations` and the
    // `ledgerExpectedQuantity` field aliased to the "expectedQuantity"
    // column id are both nested under `quantityLedger` on the list row, so
    // `readKey: null`), matching `apps/web/src/app/products/productlist.tsx`.
    interface ProductRow {
      fdc_id: number | null;
      manufacturer: string;
      model: string | null;
      notes: string | null;
      expectedQuantity: number | null;
      category: string | null;
      price: number | null;
      usdaUnavailable: boolean | null;
      stockTracked: boolean | null;
      primaryGtin: string | null;
    }
    const PRODUCT_ROW: ProductRow = {
      fdc_id: 173944,
      manufacturer: "Acme",
      model: "X-100",
      notes: "Fixture notes",
      expectedQuantity: 3,
      category: null,
      price: 12.5,
      usdaUnavailable: null,
      stockTracked: true,
      primaryGtin: null,
    };

    // The three fields that force an override, minimally stood in (a plain
    // `cell: () => null` display column) — same shape as the task fixture's
    // required overrides above.
    function buildProductOverrides<TRecord extends object>(
      helper: ReturnType<typeof createCubbyColumnHelper<TRecord>>,
    ) {
      return createCubbyColumnCollection<TRecord>((add) => {
        for (const id of [
          "dataQuality",
          "servingAsLocations",
          "expectedQuantity",
        ]) {
          add(helper.display({ id, cell: () => null }));
        }
      });
    }

    // Deliberately drops `cell` — a column's cell type is captured per-visit
    // against that column's own existentially-quantified `TValue` (see
    // `materializeCubbyColumns`'s doc in table-features.ts): carrying it out
    // through a plain mapped array collapses TValue to `unknown` and no
    // longer type-checks as callable. Metadata (id/className/mobile/
    // enableSorting) isn't TValue-parameterized, so it survives the trip.
    function buildProductColumnMeta() {
      const helper = createCubbyColumnHelper<ProductRow>();
      const columns = createEntityDisplayColumns(
        "product",
        helper,
        buildProductOverrides(helper),
      );
      return columns.visit((column) => ({
        id: String(
          column.id ?? ("accessorKey" in column ? column.accessorKey : ""),
        ),
        className: column.meta?.className,
        mobile: column.meta?.mobile,
        numeric: column.meta?.numeric,
        enableSorting: column.enableSorting,
      }));
    }

    /** Renders one column's cell against a fixture row — filtered to a single
     * column and invoked inside the same `.visit()` callback, so its `cell`
     * is used exactly where its `TValue` is still concrete. */
    function renderProductCell(columnId: string, row: ProductRow) {
      const helper = createCubbyColumnHelper<ProductRow>();
      const columns = createEntityDisplayColumns(
        "product",
        helper,
        buildProductOverrides(helper),
      );
      const matched = columns.filter(
        (column) =>
          (column.id ??
            ("accessorKey" in column ? column.accessorKey : null)) === columnId,
      );
      const rendered = matched.visit((column) =>
        renderRowCell(column.cell, row),
      );
      const [first] = rendered;
      if (rendered.length !== 1 || first === undefined) {
        throw new Error(`Expected exactly one column with id ${columnId}.`);
      }
      return first;
    }

    it("buckets declared widths into the shared table's fixed classes", () => {
      const byId = Object.fromEntries(
        buildProductColumnMeta().map((d) => [d.id, d]),
      );
      // width: "sm" -> "w-28", width: "md" -> "w-40"
      expect(byId.fdc_id?.className).toBe("w-28");
      expect(byId.category?.className).toBe("w-28");
      expect(byId.stockTracked?.className).toBe("w-28");
      expect(byId.manufacturer?.className).toBe("w-40");
      expect(byId.model?.className).toBe("w-40");
      expect(byId.notes?.className).toBe("w-40");
      // No declared width (e.g. expectedQuantity, usdaUnavailable) stays unset.
      expect(byId.expectedQuantity?.className).toBeUndefined();
    });

    it("passes declared mobile placement straight through as column meta", () => {
      const byId = Object.fromEntries(
        buildProductColumnMeta().map((d) => [d.id, d]),
      );
      expect(byId.manufacturer?.mobile).toEqual({
        slot: "subtitle",
        priority: 20,
        interactive: undefined,
      });
      expect(byId.category?.mobile).toEqual({
        slot: "subtitle",
        priority: 30,
        interactive: undefined,
      });
      // A field with no declared `display.mobile` gets no mobile meta.
      expect(byId.notes?.mobile).toBeUndefined();
    });

    it("renders format: external-link as an outbound link over the raw value", () => {
      render(<>{renderProductCell("fdc_id", PRODUCT_ROW)}</>);
      const link = screen.getByRole("link", { name: "173944" });
      expect(link).toHaveAttribute("href", "173944");
    });

    it("renders format: currency through the shared currency formatter", () => {
      const byId = Object.fromEntries(
        buildProductColumnMeta().map((d) => [d.id, d]),
      );
      expect(byId.price?.numeric).toBe(true);
      render(<>{renderProductCell("price", PRODUCT_ROW)}</>);
      expect(screen.getByText("$12.50")).toBeVisible();
    });

    it("derives enableSorting from the generated sort roster per column id", () => {
      const byId = Object.fromEntries(
        buildProductColumnMeta().map((d) => [d.id, d]),
      );
      // In `generatedEntitySort.product.fields`.
      expect(byId.manufacturer?.enableSorting).toBe(true);
      expect(byId.fdc_id?.enableSorting).toBe(true);
      expect(byId.notes?.enableSorting).toBe(true);
      // Not in the roster.
      expect(byId.stockTracked?.enableSorting).toBe(false);
      expect(byId.usdaUnavailable?.enableSorting).toBe(false);
    });

    it("leaves an override's own enableSorting alone, and fills it in only when unset", () => {
      const helper = createCubbyColumnHelper<{
        projectId: string | null;
        subjectProductId: string | null;
        parentTaskId: string | null;
        blockedByIds: string[];
        blockingIds: string[];
        trade: string;
      }>();
      const columns = createEntityDisplayColumns(
        "task",
        helper,
        createCubbyColumnCollection((add) => {
          // Required: these are reference fields, which the auto-render
          // path always rejects. Their column ids are the declared
          // `display.columnId` aliases, not the field keys.
          for (const id of ["project", "subjectProduct", "parentTask"]) {
            add(helper.display({ id, cell: () => null }));
          }
          // "trade" IS in `generatedEntitySort.task.fields`, but this
          // override deliberately opts out — that explicit choice must win
          // over the roster-derived default.
          add(
            helper.display({
              id: "trade",
              enableSorting: false,
              cell: () => null,
            }),
          );
        }),
      );
      const byId = Object.fromEntries(
        columns.visit((column) => [
          String(
            column.id ?? ("accessorKey" in column ? column.accessorKey : ""),
          ),
          {
            className: column.meta?.className,
            mobile: column.meta?.mobile,
            enableSorting: column.enableSorting,
          },
        ]),
      );
      // "status" is in `generatedEntitySort.task.fields` — the auto column
      // picks that up with no explicit `enableSorting` needed.
      expect(byId.status?.enableSorting).toBe(true);
      // "dueDate" is declared `format: "plainDate"`, `width: "sm"`, and a
      // `mobile` placement — all read straight off the task entity file.
      expect(byId.dueDate?.className).toBe("w-28");
      expect(byId.dueDate?.mobile).toEqual({
        slot: "meta",
        priority: 40,
        interactive: true,
      });
      expect(byId.dueDate?.enableSorting).toBe(true);
      // An override whose declared column id is a roster sort id sorts;
      // one outside the roster is filled in as unsortable (false), not left
      // `undefined`.
      expect(byId.project?.enableSorting).toBe(true);
      expect(byId.parentTask?.enableSorting).toBe(false);
      // The explicit override on "trade" survives despite the roster saying
      // true for that column id.
      expect(byId.trade?.enableSorting).toBe(false);
    });
  });
});
