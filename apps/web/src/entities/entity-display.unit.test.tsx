import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";

import { createEntityDisplayColumns, EntityBasicInfo } from "./entity-display";

describe("declared entity displays", () => {
  it("selects declared detail sections without leaking overview fields", () => {
    render(
      <EntityBasicInfo
        entity="project"
        section="resources"
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
          section="resources"
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
});
