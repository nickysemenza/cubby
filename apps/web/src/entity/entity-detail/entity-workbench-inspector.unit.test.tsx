import { imageWithEntitySchema } from "@cubby/schemas/image";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { vendorOut } from "@cubby/schemas/vendor";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entity/entity-query";
import {
  entityGraph,
  recommendations,
} from "~/integrations/tanstack-query/generated/catalog.gen";
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
  aliases: [],
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
  capturedAt: null,
  capturedAtOffsetMinutes: null,
  captureLocation: null,
  capturePlaceName: null,
  captureDeviceLabel: null,
  capturedByPartyId: null,
  capturedByName: null,
  captureAttribution: "none",
  provenanceEvidence: null,
  sourceEvidence: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  entityKind: null,
  entityId: null,
  entityName: null,
  associations: [],
});

const vendorRoot = { entityKind: "vendor" as const, entityId: VENDOR_ID };
const purchaseRef = {
  entityKind: "purchase" as const,
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
  const detailOptions = entityPreviewQueryOptions("image", IMAGE_ID);
  harness.queryClient.setQueryDefaults(detailOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(detailOptions.queryKey, imageRecord);
  harness.queryClient.setQueryData(
    entityGraph.graph.queryOptions({
      roots: [{ entityKind: "image", entityId: IMAGE_ID }],
      limit: 12,
    }).queryKey,
    {
      nodes: [
        {
          entityKind: "image",
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
  it("keeps record fields mounted while relationships and activity open inline", async () => {
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
    expect(
      screen.getByText("Relations", { exact: true, selector: "summary" }),
    ).toBeVisible();
    expect(
      screen.getByText("Activity", { exact: true, selector: "summary" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Open full vendor details")).toHaveAttribute(
      "href",
      `/vendors/${VENDOR_ID}`,
    );

    const recordFields = screen.getByText("Website", { exact: true });
    fireEvent.click(
      screen.getByText("Relations", { exact: true, selector: "summary" }),
    );
    expect(await screen.findByText("Fixture purchase")).toBeVisible();

    fireEvent.click(
      screen.getByText("Activity", { exact: true, selector: "summary" }),
    );
    await waitFor(() => {
      expect(
        screen.getByText("Activity", { exact: true, selector: "summary" })
          .parentElement,
      ).toHaveAttribute("open");
    });
    expect(screen.getByText("Website", { exact: true })).toBe(recordFields);
    expect(recordFields).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(closeCount).toBe(1);
  });

  it("uses the actual image preview and canonical full-detail route", async () => {
    seedImageInspector();
    renderInspector({ entity: "image", id: IMAGE_ID });

    expect(
      await screen.findByRole("heading", { name: "fixture.jpg" }),
    ).toBeVisible();
    expect(
      screen.getByText("Relations", { exact: true, selector: "summary" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit record" })).toBeVisible();
    expect(screen.getByLabelText("Open full image details")).toHaveAttribute(
      "href",
      `/images/${IMAGE_ID}`,
    );
  });
});
