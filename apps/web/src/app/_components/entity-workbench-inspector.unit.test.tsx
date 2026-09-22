import { imageWithEntitySchema } from "@cubby/schemas/image";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { vendorOut } from "@cubby/schemas/vendor";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityGraph } from "~/entities/entity-graph.functions";
import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { image } from "~/entities/image.functions";
import { recommendations } from "~/lib/recommendations.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityWorkbenchInspector } from "./entity-workbench-inspector";

const VENDOR_ID = testShortcode("vendor", "VEN-WORK");
const IMAGE_ID = testShortcode("image", "IMG-WORK");

const vendor = vendorOut.parse({
  id: VENDOR_ID,
  name: "Fixture vendor",
  website: null,
  orderUrlTemplate: null,
  orderEvidence: null,
  orderEmailSenders: [],
  browserDomains: [],
  agentHints: {
    ordersListUrl: null,
    pagination: null,
    orderLinkPattern: null,
    notes: [],
  },
  returnWindowDays: null,
  notes: null,
  purchaseCount: 1,
  spend: 24,
  latestPurchaseDate: "2026-06-16",
  logo: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  dataQuality: testCompleteDataQuality(),
});

const imageRecord = imageWithEntitySchema.parse({
  id: IMAGE_ID,
  url: "https://example.test/fixture.jpg",
  key: "fixtures/fixture.jpg",
  filename: "fixture.jpg",
  size: 1024,
  contentType: "image/jpeg",
  status: "UPLOADED",
  useOriginal: false,
  width: 640,
  height: 480,
  detectedContentType: "image/jpeg",
  sha256: null,
  renderStatus: "verified",
  storageStatus: "available",
  source: "unknown",
  sourcePageUrl: null,
  sourceAssetUrl: null,
  sourceName: null,
  verifiedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  entityType: null,
  entityId: null,
  entityName: null,
  associations: [],
});

const vendorRoot = { entityType: "vendor" as const, entityId: VENDOR_ID };
const purchaseRef = {
  entityType: "purchase" as const,
  entityId: testShortcode("purchase", "PUR-WORK"),
};
const vendorRelationships = {
  nodes: [
    { ...vendorRoot, label: vendor.name, metadata: {} },
    { ...purchaseRef, label: "Fixture purchase", metadata: {} },
  ],
  edges: [],
  branches: [
    {
      root: vendorRoot,
      relationshipKey: "purchases",
      target: "purchase",
      label: "Purchases",
      totalCount: 1,
      edgeIds: [],
      nextOffset: null,
      items: [purchaseRef],
    },
  ],
  truncated: false,
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function seedVendorInspector() {
  const detailOptions = entityPreviewQueryOptions("vendor", VENDOR_ID);
  harness.queryClient.setQueryDefaults(detailOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(detailOptions.queryKey, vendor);

  const relationshipOptions = entityGraph.graph.queryOptions({
    roots: [vendorRoot],
    limit: 12,
  });
  harness.queryClient.setQueryDefaults(relationshipOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(
    relationshipOptions.queryKey,
    vendorRelationships,
  );

  const explorationOptions = entityGraph.explore.queryOptions({
    root: vendorRoot,
    depth: 1,
  });
  harness.queryClient.setQueryDefaults(explorationOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(explorationOptions.queryKey, {
    ...vendorRelationships,
    paths: [],
    completion: {
      status: "depth-limit",
      requestedDepth: 1,
      reachedDepth: 1,
    },
  });

  const recommendationOptions =
    recommendations.forEntity.queryOptions(vendorRoot);
  harness.queryClient.setQueryDefaults(recommendationOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(recommendationOptions.queryKey, {
    source: vendorRoot,
    basisKey: "fixture-vendor",
    groups: [],
  });
}

function seedImageInspector() {
  const detailOptions = image.detail.queryOptions({ id: IMAGE_ID });
  harness.queryClient.setQueryDefaults(detailOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(detailOptions.queryKey, imageRecord);
  harness.queryClient.setQueryData(
    entityGraph.graph.queryOptions({
      roots: [{ entityType: "image", entityId: IMAGE_ID }],
      limit: 12,
    }).queryKey,
    {
      nodes: [
        {
          entityType: "image",
          entityId: IMAGE_ID,
          label: "fixture.jpg",
          metadata: {},
        },
      ],
      edges: [],
      branches: [],
      truncated: false,
    },
  );
}

function renderInspector({
  entity = "vendor",
  id = VENDOR_ID,
  onClose,
}: {
  entity?: "vendor" | "image";
  id?: string;
  onClose?: () => void;
} = {}) {
  return render(
    <EntityWorkbenchInspector entity={entity} id={id} onClose={onClose} />,
    { wrapper: harness.wrapper },
  );
}

describe("EntityWorkbenchInspector", () => {
  it("keeps the compact overview local until a real relationship or activity tab is selected", async () => {
    seedVendorInspector();
    let closeCount = 0;
    renderInspector({ onClose: () => (closeCount += 1) });

    expect(
      await screen.findByRole("heading", { name: "Fixture vendor" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("navigation", {
        name: "Fixture vendor relationships",
      }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();
    expect(screen.getByLabelText("Open full vendor details")).toHaveAttribute(
      "href",
      `/vendors/${VENDOR_ID}`,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(await screen.findByText("Fixture purchase")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await waitFor(() => {
      expect(screen.getByText("No activity yet")).toBeVisible();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(closeCount).toBe(1);
  });

  it("uses the actual image preview and canonical full-detail route", async () => {
    seedImageInspector();
    renderInspector({ entity: "image", id: IMAGE_ID });

    expect(
      await screen.findByRole("heading", { name: "fixture.jpg" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.getByLabelText("Open full image details")).toHaveAttribute(
      "href",
      `/images/${IMAGE_ID}`,
    );
  });

  // A test formerly lived here covering a route-less selection (rerendering
  // with `entity="ledgerParty"` mid-session): once `LedgerParty`/
  // `LedgerTransfer` gained browser routes, no `Entity` variant is route-less
  // any more, so `UnsupportedOverview`'s "route-less" copy branch and the
  // "no Open full record link" assertion it covered are dead code with
  // nothing left to construct a fixture from. Removed rather than kept
  // failing or weakened; `isBrowserRoutedEntity`'s guard in
  // `entity-workbench-inspector.tsx` still exists for a future route-less
  // entity, but it currently has no live caller to exercise it.
});
