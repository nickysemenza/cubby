import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { CellData } from "@tanstack/react-table";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { isReferencePickerEntity } from "~/app/_components/combobox/reference-entity-search";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/app/_components/data-table/table-features";
import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
} from "~/app/_components/entity-media/entity-display-images";
import { useStandardColumns } from "~/app/_components/hooks/useStandardColumns";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  createEntityDisplayColumns,
  editableFieldOverrides,
  EntityBasicInfo,
  entitySectionFields,
  renderDetailFieldValue,
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
  it("links shortcodes in editable product notes beside a working edit control", async () => {
    const overrides = editableFieldOverrides(
      "product",
      { id: "PRD-4K7M", notes: "Neck label: IMG-4S9Q" },
      ["notes"],
      vi.fn().mockResolvedValue(undefined),
    );
    const notes = overrides.notes;
    if (!notes) throw new Error("Product notes override is missing");
    const harness = createBrowserTestHarness();
    render(<>{notes().value}</>, { wrapper: harness.wrapper });

    const link = screen.getByRole("link", { name: "IMG-4S9Q" });
    expect(link).toHaveAttribute("href", "/images/IMG-4S9Q");
    expect(link.closest("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));
    expect(await screen.findByRole("textbox")).toHaveValue(
      "Neck label: IMG-4S9Q",
    );
    harness.dispose();
  });
  it("formats purchase expense totals as money despite floating point residue", () => {
    const field = entityFieldModels.purchase.fields.find(
      (field) => field.key === "expenseTotal",
    )!;
    render(
      <>
        {renderDetailFieldValue(
          "purchase",
          { expenseTotal: 12.299999999999 },
          field,
        )}
      </>,
    );
    expect(screen.getByText("$12.30")).toBeVisible();
  });
  it("has a picker path for every updateable singular reference shown in a manifest list", () => {
    // Current list-visible update references span these targets: the roster is
    // intentionally target-based because several entities reuse the same
    // picker (for example Planting and Expense both select Product).
    for (const entity of [
      "ingredient",
      "location",
      "product",
      "project",
      "task",
      "vendor",
      "ledgerParty",
      "financialAccount",
      "purchase",
      "planting",
    ] as const) {
      expect(isReferencePickerEntity(entity)).toBe(true);
    }
  });

  it("selects declared detail sections without leaking overview fields", () => {
    render(
      <EntityBasicInfo
        entity="project"
        fields={entitySectionFields("project", "resource-links")}
        record={{
          name: "Fixture project",
          googleDriveFolderUrl: "https://example.com/folder",
          notionPageUrl: "https://example.com/page",
        }}
      />,
    );
    expect(screen.getByText("Google drive folder URL")).toBeVisible();
    expect(screen.getByText("Notion page URL")).toBeVisible();
    expect(screen.queryByText("Name")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture project")).not.toBeInTheDocument();
  });

  it("rejects a renderer assigned to a different declared detail section", () => {
    expect(() =>
      render(
        <EntityBasicInfo
          entity="project"
          fields={entitySectionFields("project", "resource-links")}
          record={{ name: "Fixture project" }}
          overrides={{ name: (record) => ({ value: record.name }) }}
        />,
      ),
    ).toThrow("Undeclared detail renderer for project.name");
  });

  it("keeps computed facts next to their declared owner and permits value-dependent labels", () => {
    // `kind` has a list filter descriptor, so the fact row carries a cohort
    // link and needs the router the harness provides.
    const harness = createBrowserTestHarness();
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
      { wrapper: harness.wrapper },
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
    harness.dispose();
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

  it("leads manifest reference links with the target's identity mark", () => {
    const harness = createBrowserTestHarness();
    render(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={{
          [entityDisplayImageKey({
            entityType: "image",
            entityId: "IMG-TEST",
          })]: { url: "https://images.example/sighting.jpg" },
          [entityDisplayImageKey({
            entityType: "ledgerParty",
            entityId: "LPY-TEST",
          })]: null,
        }}
      >
        <EntityBasicInfo
          entity="imageSighting"
          fields={["imageId", "ledgerPartyId"]}
          cohortLinks={false}
          record={{ imageId: "IMG-TEST", ledgerPartyId: "LPY-TEST" }}
        />
      </EntityDisplayImagesProvider>,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("link", { name: "IMG-TEST" }).querySelector("img"),
    ).toHaveAttribute("src", "https://images.example/sighting.jpg");
    // No cover: the entity icon holds the mark's box instead of an image.
    const party = screen.getByRole("link", { name: "LPY-TEST" });
    expect(party.querySelector("img")).toBeNull();
    expect(party.querySelector("[aria-hidden] svg")).not.toBeNull();
    harness.dispose();
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
    // `spend` declares `format: signedCurrency`, which the detail honours.
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("makes updateable singular manifest references editable with ID-only paste and nullable clear", async () => {
    type PlantingRow = {
      id: string;
      ingredientId: string;
      ingredientName: string;
      locationId: string | null;
      locationName: string | null;
      sourceProductId: string | null;
      sourceProductName: string | null;
      taskId: string | null;
      taskName: string | null;
      status: string;
      variety: string | null;
      quantity: string | null;
      notes: string | null;
      plannedWindow: string | null;
      sowedOn: string | null;
      transplantedOn: string | null;
      finishedOn: string | null;
    };
    const row: PlantingRow = {
      id: "PLT-TEST",
      ingredientId: "ING-TEST",
      ingredientName: "Tomato",
      locationId: "LOC-TEST",
      locationName: "Raised bed",
      sourceProductId: null,
      sourceProductName: null,
      taskId: null,
      taskName: null,
      status: "growing",
      variety: null,
      quantity: null,
      notes: null,
      plannedWindow: null,
      sowedOn: null,
      transplantedOn: null,
      finishedOn: null,
    };
    const onSaveField = vi.fn().mockResolvedValue(undefined);
    const columns = createEntityDisplayColumns(
      "planting",
      createCubbyColumnHelper<PlantingRow>(),
      undefined,
      { onSaveField },
    );
    const cellData = columns
      .visit((column) =>
        column.id === "locationId" ? column.meta?.cellData : undefined,
      )
      .find((value) => value !== undefined);
    if (!cellData) throw new Error("Expected a location cell descriptor.");

    expect(cellData.kind).toBe("entity:location");
    expect(cellData.getCopyPayload(row)).toEqual({
      text: "Raised bed",
      json: { id: "LOC-TEST", name: "Raised bed" },
    });
    await expect(
      cellData.applyPaste?.(row, {
        json: { id: "LOC-NEXT", name: "Sun bed" },
      }),
    ).resolves.toEqual({ id: "LOC-NEXT", name: "Sun bed" });
    await expect(cellData.applyClear?.(row)).resolves.toBeNull();
    expect(onSaveField).toHaveBeenNthCalledWith(
      1,
      row,
      "locationId",
      "LOC-NEXT",
    );
    expect(onSaveField).toHaveBeenNthCalledWith(2, row, "locationId", null);
    await expect(
      cellData.applyPaste?.(row, { text: "Raised bed" }),
    ).rejects.toThrow("Paste a location cell here");
  });

  it.each([undefined, "Old local label"])(
    "keeps titleField out of declared facts for renderer header %s",
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
        { id: "kind", header: "Kind" },
        { id: "notes", header: "Notes" },
        { id: "dataQuality", header: "Data quality" },
      ]);
      expect(details[0]).toMatchObject({
        cellIsOverride: false,
      });
      expect(details[1]?.copied).toEqual({
        text: "Review these notes",
        json: "Review these notes",
      });
    },
  );

  it("places a Purchase's own identity before embedded relation facts", () => {
    type PurchaseRow = {
      id: string;
      displayName: string;
      displayImages?: [];
      vendorName: string | null;
      displayLabel: string | null;
      date: string;
      statedTotal: number | null;
    };
    const helper = createCubbyColumnHelper<PurchaseRow>();
    const declared = createEntityDisplayColumns("purchase", helper, undefined, {
      only: ["vendorId", "displayLabel", "date", "statedTotal"],
    });
    const { result } = renderHook(() =>
      useStandardColumns({
        entity: "purchase",
        columnHelper: helper,
        customColumns: declared,
        filters: [],
        enableRowSelection: false,
        mappingsMap: null,
        hasUnitMappings: false,
      }),
    );
    expect(result.current.visit((column) => column.id).slice(0, 6)).toEqual([
      "image",
      "displayName",
      "vendorId",
      "displayLabel",
      "date",
      "statedTotal",
    ]);
  });

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

  it("attaches reference provenance to declared specialized columns", () => {
    const helper = createCubbyColumnHelper<{
      fromPartyId: string;
      toPartyId: string;
    }>();
    const columns = createEntityDisplayColumns(
      "ledgerTransfer",
      helper,
      createCubbyColumnCollection((add) => {
        for (const id of [
          "fromPartyId",
          "toPartyId",
          "evidenceTransactionIds",
        ]) {
          add(helper.display({ id, header: "Specialized", cell: () => null }));
        }
      }),
    );
    expect(columns.visit((column) => column.id)).toContain(
      "evidenceTransactionIds",
    );
    const evidenceProvenance = columns
      .visit((column) =>
        column.id === "evidenceTransactionIds"
          ? column.meta?.provenance
          : undefined,
      )
      .find((provenance) => provenance !== undefined);
    expect(evidenceProvenance).toEqual({
      kind: "reference",
      sources: [
        { entity: "financialTransaction", label: null, relation: null },
      ],
    });
  });

  describe("declared width/format/mobile/sorting", () => {
    // Most of `product`'s `list: true` roster is plain scalars, exercised
    // here with zero overrides — the cleanest surface for the generic
    // mapping itself. Two fields still force an override regardless
    // (`servingAsLocations` and `ledgerExpectedQuantity` are nested under
    // `quantityLedger` on the list row, so `readKey: null`), matching
    // `apps/web/src/app/products/productlist.tsx`; `dataQuality` comes from
    // its manifest-declared renderer.
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

    // The two fields that force an override, minimally stood in (a plain
    // `cell: () => null` display column) — same shape as the task fixture's
    // required overrides above.
    function buildProductOverrides<TRecord extends object>(
      helper: ReturnType<typeof createCubbyColumnHelper<TRecord>>,
    ) {
      return createCubbyColumnCollection<TRecord>((add) => {
        for (const id of ["servingAsLocations", "ledgerExpectedQuantity"]) {
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
      expect(byId.categoryId?.className).toBe("w-40");
      expect(byId.stockTracked?.className).toBe("w-28");
      expect(byId.manufacturer?.className).toBe("w-40");
      expect(byId.model?.className).toBe("w-40");
      expect(byId.notes?.className).toBe("w-40");
      // No declared width (e.g. ledgerExpectedQuantity, usdaUnavailable) stays unset.
      expect(byId.ledgerExpectedQuantity?.className).toBeUndefined();
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
      expect(byId.categoryId?.mobile).toEqual({
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
          // path always rejects. Their column ids are the field keys.
          for (const id of ["projectId", "subjectProductId", "parentTaskId"]) {
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
      expect(byId.projectId?.enableSorting).toBe(true);
      expect(byId.parentTaskId?.enableSorting).toBe(false);
      // The explicit override on "trade" survives despite the roster saying
      // true for that column id.
      expect(byId.trade?.enableSorting).toBe(false);
    });
  });
});

/**
 * Every enum field reads one roster (`enumFieldOptions`) on every surface:
 * a read-only list cell (no `onSaveField` — the embedded relation table's
 * path) and the detail value both show the rich label in a pill, whether the
 * label comes from the rich `ENTITY_SELECT_OPTIONS` table (task, expense,
 * image — image declares no `control` at all) or from static
 * `control.options` (planting). Regression: relation tables and hero chips
 * used to print the raw stored value (`not_started`, `principal`).
 */
describe("generic enum fields", () => {
  const rows: {
    entity: Entity;
    key: string;
    raw: string;
    label: string;
  }[] = [
    { entity: "task", key: "status", raw: "not_started", label: "Not started" },
    {
      entity: "expense",
      key: "lineKind",
      raw: "principal",
      label: "Item or service",
    },
    { entity: "planting", key: "status", raw: "growing", label: "Growing" },
    { entity: "image", key: "status", raw: "UPLOADED", label: "Uploaded" },
    // A stored value the roster forgot prints itself, never "—".
    { entity: "task", key: "status", raw: "zzz", label: "zzz" },
  ];

  function fieldOf(entity: Entity, key: string) {
    const field = entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === key,
    );
    if (!field) throw new Error(`${entity}.${key} is not declared`);
    return field;
  }

  it.each(rows)(
    "$entity.$key renders $raw as the pill $label on list and detail",
    ({ entity, key, raw, label }) => {
      const record = { id: `${entity}-1`, [key]: raw };
      const helper = createCubbyColumnHelper<typeof record>();
      const columns = createEntityDisplayColumns(entity, helper, undefined, {
        only: [key],
      });
      const [listCell] = columns.visit((column) =>
        renderRowCell(column.cell, record),
      );
      const { unmount } = render(<>{listCell}</>);
      expect(screen.getByText(label)).toBeVisible();
      // Exactly one rendering: the label replaces the raw value rather than
      // sitting beside it (the unknown-value row keeps them equal).
      expect(
        screen.getAllByText(new RegExp(`^(${label}|${raw})$`)),
      ).toHaveLength(1);
      unmount();

      render(
        <>{renderDetailFieldValue(entity, record, fieldOf(entity, key))}</>,
      );
      expect(screen.getByText(label)).toBeVisible();
    },
  );

  // Range copy/paste reads `meta.cellData`, never the rendered cell, so an
  // editable column that renders correctly can still drop out of the copy
  // range (PR #766 review). Every generic control kind must publish one.
  it("keeps every editable list control kind in the copy/paste range", async () => {
    const record = {
      id: "expense-1",
      cost: 20,
      date: "2026-07-20",
      future: false,
      productQuantity: 2,
      costType: "materials",
    };
    const helper = createCubbyColumnHelper<typeof record>();
    const onSaveField = vi.fn().mockResolvedValue(undefined);
    const columns = createEntityDisplayColumns("expense", helper, undefined, {
      only: ["cost", "date", "future", "productQuantity", "costType"],
      onSaveField,
    });
    const cells = new Map(
      columns.visit((column) => [column.id, column.meta?.cellData] as const),
    );
    expect(
      Object.fromEntries([...cells].map(([id, data]) => [id, data?.kind])),
    ).toEqual({
      cost: "currency",
      date: "date",
      future: "boolean",
      productQuantity: "number",
      costType: "select",
    });
    expect(cells.get("costType")?.getCopyPayload(record)).toEqual({
      text: "Materials",
      json: "materials",
    });
    // `productQuantity` is signed: a negative quantity on a $0 line is a
    // discard, so rejecting one would make discards uneditable everywhere.
    await cells.get("productQuantity")?.applyPaste?.(record, { json: -1 });
    expect(onSaveField).toHaveBeenCalledWith(record, "productQuantity", -1);
    await cells.get("future")?.applyPaste?.(record, { json: true });
    expect(onSaveField).toHaveBeenCalledWith(record, "future", true);
  });

  it("saves an editable pick through onSaveField, and clears only a nullable enum", async () => {
    const record = { id: "task-1", status: "not_started", trade: "plumbing" };
    const helper = createCubbyColumnHelper<typeof record>();
    const onSaveField = vi.fn().mockResolvedValue(undefined);
    const columns = createEntityDisplayColumns("task", helper, undefined, {
      only: ["status", "trade"],
      onSaveField,
    });
    const [statusCell, tradeCell] = columns.visit((column) =>
      renderRowCell(column.cell, record),
    );
    // `trade` declares `control.suggest`, so its open editor mounts the Jev
    // apply affordance, which queries — hence the harness.
    const harness = createBrowserTestHarness();

    const status = render(<>{statusCell}</>, { wrapper: harness.wrapper });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("option", { name: "Done" }));
    await waitFor(() => {
      expect(onSaveField).toHaveBeenCalledWith(record, "status", "done");
    });
    // `status` is required: no clear affordance.
    expect(
      screen.queryByRole("button", { name: /^Clear/i, hidden: true }),
    ).toBeNull();
    status.unmount();

    render(<>{tradeCell}</>, { wrapper: harness.wrapper });
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("option", { name: "Plumbing" });
    // `trade` is nullable (reset to inherited): the clear affordance shows.
    expect(
      screen.getByRole("button", { name: /^Clear/i, hidden: true }),
    ).toBeInTheDocument();
    // The open editor asks Jev for `trade` (declared `control.suggest`, as a
    // "provided" alternative since a value is stored) and never for `status`
    // (no `suggest`) — the generic list editor used to omit this entirely.
    const suggestionTargets = harness.queryClient
      .getQueryCache()
      .findAll()
      .map((query) => JSON.stringify(query.queryKey))
      .filter((key) => key.includes("suggestFields"));
    expect(suggestionTargets).toHaveLength(1);
    expect(suggestionTargets[0]).toContain('"targets":["trade"]');
    expect(suggestionTargets[0]).toContain('"basisMode":"provided"');
    harness.dispose();
  });
});
