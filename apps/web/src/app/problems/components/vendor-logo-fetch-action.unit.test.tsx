import { testShortcode } from "@cubby/schemas/testing";
import { vendorOut } from "@cubby/schemas/vendor";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { vendor as vendorOperations } from "~/app/vendors/vendor.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type VendorLogoFetchOperations,
  VendorLogoFetchAction,
} from "./vendor-logo-fetch-action";

const vendor = {
  id: testShortcode("vendor", "VEN-2345"),
  name: "Example Supply",
  website: "https://example.com",
};

const fetchedVendor = vendorOut.parse({
  ...vendor,
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
  purchaseCount: 0,
  spend: 0,
  latestPurchaseDate: null,
  logo: null,
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:00:00.000Z"),
});

function createOperations() {
  const requests: Array<{ id: (typeof vendor)["id"] }> = [];
  const fetchLogo = vendorOperations.fetchLogo.withTransport(
    async ({ input }) => {
      requests.push(input);
      return fetchedVendor;
    },
  );
  return {
    operations: { fetchLogo: fetchLogo.mutationOptions },
    requests,
  } satisfies {
    operations: VendorLogoFetchOperations;
    requests: Array<{ id: (typeof vendor)["id"] }>;
  };
}

function createPendingOperations(): VendorLogoFetchOperations {
  const fetchLogo = vendorOperations.fetchLogo.withTransport(
    () => new Promise<typeof fetchedVendor>(() => undefined),
  );
  return { fetchLogo: fetchLogo.mutationOptions };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

describe("VendorLogoFetchAction", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });

  afterEach(() => {
    harness.dispose();
  });

  it("offers an explicit fetch for a vendor with a website", async () => {
    const { operations, requests } = createOperations();
    render(<VendorLogoFetchAction vendor={vendor} operations={operations} />, {
      wrapper: harness.wrapper,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Fetch logo" }));
    await waitFor(() => expect(requests).toEqual([{ id: vendor.id }]));
  });

  it("renders no action until a website is recorded", () => {
    const { container } = render(
      <VendorLogoFetchAction
        vendor={{ ...vendor, website: null }}
        operations={createOperations().operations}
      />,
      { wrapper: harness.wrapper },
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a disabled pending state", async () => {
    render(
      <VendorLogoFetchAction
        vendor={vendor}
        operations={createPendingOperations()}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Fetch logo" }));

    expect(
      await screen.findByRole("button", { name: "Fetching…" }),
    ).toBeDisabled();
  });
});
