import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";

const vendorOut = entityFieldEnvelopeSchemas.vendor.detail;
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entity/entity-query";
import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";
import { entityMetadataQueryOptions } from "~/entity/metadata";
import { installFeatures } from "~/features/registry";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";
import { recommendations } from "~/integrations/tanstack-query/generated/catalog/recommendations.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { loadEntityMetadata } from "~/server/entity-metadata/loader.server";

import { EntityWorkbenchInspector } from "./entity-workbench-inspector";

installFeatures();

const VENDOR_ID = testShortcode("vendor", "VEN-WORK");
const IMAGE_ID = testShortcode("image", "IMG-WORK");

const vendor = entityReadFixture(vendorOut, {
  attachments: [],
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
  logo: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  fields: {
    role: fieldValueFixture(vendorOut.shape.fields.shape.role, "seller"),
    dataQuality: fieldValueFixture(
      vendorOut.shape.fields.shape.dataQuality,
      testCompleteDataQuality(),
    ),
  },
});

const imageRecord = entityReadFixture(entityFieldEnvelopeSchemas.image.detail, {
  id: IMAGE_ID,
  fields: {
    url: fieldValueFixture(
      entityFieldEnvelopeSchemas.image.detail.shape.fields.shape.url,
      "https://example.test/fixture.jpg",
    ),
    representations: fieldValueFixture(
      entityFieldEnvelopeSchemas.image.detail.shape.fields.shape
        .representations,
      null,
    ),
  },
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

beforeEach(async () => {
  harness = createBrowserTestHarness();
  await Promise.all(
    (["vendor", "image"] as const).map(async (entity) => {
      const { primary, dependencies } = await loadEntityMetadata(entity);
      for (const metadata of [primary, ...dependencies]) {
        harness.queryClient.setQueryData(
          entityMetadataQueryOptions(metadata.entity).queryKey,
          metadata,
        );
      }
    }),
  );
});

afterEach(() => {
  harness.dispose();
});

function seedVendorInspector(record = vendor) {
  const detailOptions = entityPreviewQueryOptions("vendor", VENDOR_ID);
  harness.queryClient.setQueryDefaults(detailOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(detailOptions.queryKey, record);

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

function seedImageInspector(record = imageRecord) {
  const detailOptions = entityPreviewQueryOptions("image", IMAGE_ID);
  harness.queryClient.setQueryDefaults(detailOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(detailOptions.queryKey, record);
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
  it("keeps missing image dimensions visible and names their missing state", async () => {
    seedImageInspector({ ...imageRecord, width: null, height: null });
    renderInspector({ entity: "image", id: IMAGE_ID });
    expect(
      await screen.findByRole("heading", { name: "fixture.jpg" }),
    ).toBeVisible();
    for (const label of ["Width", "Height"])
      for (const field of screen.getAllByText(label, { exact: true }))
        expect(field).toBeVisible();
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThanOrEqual(
      2,
    );
  });
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
    expect(screen.getByRole("button", { name: "Relations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Activity" })).toBeVisible();
    expect(screen.getByLabelText("Open full vendor details")).toHaveAttribute(
      "href",
      `/vendors/${VENDOR_ID}`,
    );

    const recordFields = screen.getByText("Website", { exact: true });
    fireEvent.click(screen.getByRole("button", { name: "Relations" }));
    expect(await screen.findByText("Fixture purchase")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
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
    expect(screen.getByRole("button", { name: "Relations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit record" })).toBeVisible();
    expect(screen.getByLabelText("Open full image details")).toHaveAttribute(
      "href",
      `/images/${IMAGE_ID}`,
    );
  });
});

it("shows the inspector's governed cover snapshot", async () => {
  seedVendorInspector({
    ...vendor,
    fields: {
      ...vendor.fields,
      displayImages: fieldValueFixture(
        vendorOut.shape.fields.shape.displayImages,
        [{ id: "IMG-4K7M", url: "https://example.test/current-cover.jpg" }],
      ),
    },
  });
  renderInspector();
  expect(
    await screen.findByRole("img", { name: "Fixture vendor" }),
  ).toHaveAttribute("src", expect.stringContaining("current-cover.jpg"));
});

it.each([{ images: undefined }, { images: [] }])(
  "never revives a retired inspector cover for missing or empty outcomes",
  async ({ images }) => {
    const record = {
      ...vendor,
      displayImages: [
        { id: "IMG-4K7M", url: "https://example.test/stale-cover.jpg" },
      ],
      fields: {
        ...vendor.fields,
        displayImages: fieldValueFixture(
          vendorOut.shape.fields.shape.displayImages,
          images,
        ),
      },
    };
    seedVendorInspector(record);
    renderInspector();
    await screen.findByRole("heading", { name: "Fixture vendor" });
    expect(screen.queryByRole("img", { name: "Fixture vendor" })).toBeNull();
  },
);
