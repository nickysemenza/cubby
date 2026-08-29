import { imageWithEntitySchema } from "@cubby/schemas/image";
import {
  relatedPreviewOutput,
  relatedViewsFor,
} from "@cubby/schemas/related-view";
import { testShortcode } from "@cubby/schemas/testing";
import { vendorOut } from "@cubby/schemas/vendor";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { image } from "~/entities/image.functions";
import { relatedData } from "~/lib/related-data.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityWorkbenchInspector } from "./entity-workbench-inspector";

const VENDOR_ID = testShortcode("vendor", "VEN-WORK");
const IMAGE_ID = testShortcode("image", "IMG-WORK");

const vendor = vendorOut.parse({
  id: VENDOR_ID,
  name: "Fixture vendor",
  website: null,
  orderUrlTemplate: null,
  notes: null,
  purchaseCount: 1,
  spend: 24,
  latestPurchaseDate: "2026-06-16",
  logo: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

const imageRecord = imageWithEntitySchema.parse({
  id: IMAGE_ID,
  url: "https://example.test/fixture.jpg",
  key: "fixtures/fixture.jpg",
  filename: "fixture.jpg",
  size: 1024,
  contentType: "image/jpeg",
  status: "UPLOADED",
  width: 640,
  height: 480,
  detectedContentType: "image/jpeg",
  sha256: null,
  renderStatus: "verified",
  storageStatus: "available",
  verifiedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  entityType: null,
  entityId: null,
  entityName: null,
  associations: [],
});

const vendorViews = relatedViewsFor("vendor");
const vendorRelationshipInput = {
  source: "vendor" as const,
  sourceIds: [VENDOR_ID],
  relationKeys: vendorViews.map((view) => view.key),
};
const vendorRelationships = relatedPreviewOutput.parse([
  {
    sourceId: VENDOR_ID,
    relationKey: "vendor.purchases",
    totalCount: 1,
    items: [
      {
        entity: "purchase",
        id: testShortcode("purchase", "PUR-WORK"),
        label: "Fixture purchase",
        displayImage: null,
      },
    ],
  },
]);

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

  const relationshipOptions = relatedData.previews.queryOptions(
    vendorRelationshipInput,
  );
  harness.queryClient.setQueryDefaults(relationshipOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(
    relationshipOptions.queryKey,
    vendorRelationships,
  );
}

function seedImageInspector() {
  const detailOptions = image.detail.queryOptions({ id: IMAGE_ID });
  harness.queryClient.setQueryDefaults(detailOptions.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(detailOptions.queryKey, imageRecord);
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
    expect(screen.getByTestId("relationship-route-preview")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();
    expect(screen.getByLabelText("Open full vendor details")).toHaveAttribute(
      "href",
      `/vendors/${VENDOR_ID}`,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(await screen.findByText("Fixture purchase")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("No activity yet")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(closeCount).toBe(1);
  });

  it("uses the actual image preview and canonical full-detail route", async () => {
    seedImageInspector();
    renderInspector({ entity: "image", id: IMAGE_ID });

    expect(
      await screen.findByRole("heading", { name: "fixture.jpg" }),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Relations" })).toBeNull();
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
