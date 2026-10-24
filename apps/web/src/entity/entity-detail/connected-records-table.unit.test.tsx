import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { ConnectionPaths } from "~/entity/relationships/connection-paths";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ConnectedRecordsSection } from "./connected-records-table";

describe("record connection evidence", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("keeps distinct records with equal labels visibly identifiable and linked", () => {
    const source = { entityKind: "email", entityId: "EML-TEST" } as const;
    const targets = ["SHIP-ONE", "SHIP-TWO"].map(
      (entityId) =>
        ({
          entityKind: "shipment",
          entityId,
          label: "Synthetic parcel",
        }) as const,
    );
    const query = entityGraph.connectedRecordsPreview.queryOptions({
      source,
      limit: 3,
    });
    harness.queryClient.setQueryDefaults(query.queryKey, {
      staleTime: Infinity,
    });
    harness.queryClient.setQueryData(query.queryKey, {
      views: [
        {
          viewKey: "entity:shipment",
          title: "Shipments",
          targetEntity: "shipment",
          totalCount: 2,
          evidence: false,
          items: targets.map((target) => ({
            target,
            shortestHops: 1,
            paths: [[{ ...source, label: "Synthetic email" }, target]],
          })),
        },
      ],
    });
    render(
      <EntityDisplayImagesProvider
        refs={[]}
        seeded={Object.fromEntries(
          [source, ...targets].map((ref) => [
            `${ref.entityKind}:${ref.entityId}`,
            null,
          ]),
        )}
      >
        <ConnectedRecordsSection source="email" sourceId="EML-TEST" />
      </EntityDisplayImagesProvider>,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.getByRole("link", { name: "Synthetic parcel · SHIP-ONE" }),
    ).toHaveAttribute("href", "/shipments/SHIP-ONE");
    expect(
      screen.getByRole("link", { name: "Synthetic parcel · SHIP-TWO" }),
    ).toHaveAttribute("href", "/shipments/SHIP-TWO");
  });

  it("links the shortest witnessed route and expands other routes", () => {
    render(
      <ConnectionPaths
        paths={[
          [
            {
              entityKind: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityKind: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
          [
            {
              entityKind: "plant",
              entityId: "PLT-TEST",
              label: "Example crop",
            },
            {
              entityKind: "product",
              entityId: "PRD-SEED",
              label: "Example seeds",
            },
            {
              entityKind: "expense",
              entityId: "EXP-TEST",
              label: "Example expense",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label: "Example order",
            },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Via Direct connection · 2 paths" }),
    );
    expect(
      screen.getAllByRole("link", { name: "Example seeds" })[0],
    ).toHaveAttribute("href", "/products/PRD-SEED");
    expect(
      screen.getByRole("link", { name: "Example expense" }),
    ).toHaveAttribute("href", "/expenses/EXP-TEST");
    expect(
      screen.getAllByRole("link", { name: "Example order" })[0],
    ).toHaveAttribute("href", "/purchases/PUR-TEST");
  });

  it("explains a connection whose evidence passes through storage-only rows", () => {
    render(
      <ConnectionPaths
        paths={[
          [
            {
              entityKind: "email",
              entityId: "EML-TEST",
              label: "Synthetic tracking email",
            },
            {
              entityKind: "shipment",
              entityId: "SHIP-TEST",
              label: "Synthetic parcel",
              via: {
                relationshipKey: "tracking-emails",
                label: "Tracking evidence",
                sourceKey: "direct",
                provenance: ["incoming:ShipmentObservation.shipmentId"],
              },
            },
          ],
        ]}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Via Tracking evidence" }),
    );
    expect(
      screen.getByRole("link", { name: "Synthetic parcel" }),
    ).toHaveAttribute("href", "/shipments/SHIP-TEST");
  });
});
