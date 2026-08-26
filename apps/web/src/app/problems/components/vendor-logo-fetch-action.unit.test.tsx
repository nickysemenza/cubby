import { testShortcode } from "@cubby/schemas/testing";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useProblemCardMutation: vi.fn(),
  fetchVendorLogoMutationOptions: vi.fn(),
}));

vi.mock("~/app/_components/hooks/useProblemCardMutation", () => ({
  useProblemCardMutation: mocks.useProblemCardMutation,
}));

vi.mock("~/app/vendors/vendor.functions", () => ({
  vendor: {
    fetchLogo: {
      mutationOptions: mocks.fetchVendorLogoMutationOptions,
    },
  },
}));

import { VendorLogoFetchAction } from "./vendor-logo-fetch-action";

const vendor = {
  id: testShortcode("vendor", "VEN-2345"),
  name: "Example Supply",
  website: "https://example.com",
};

describe("VendorLogoFetchAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProblemCardMutation.mockReturnValue({
      mutate: mocks.mutate,
      isPending: false,
    });
  });

  it("offers an explicit fetch for a vendor with a website", () => {
    render(<VendorLogoFetchAction vendor={vendor} />);

    fireEvent.click(screen.getByRole("button", { name: "Fetch logo" }));
    expect(mocks.mutate).toHaveBeenCalledWith({ id: vendor.id });
    expect(mocks.useProblemCardMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: mocks.fetchVendorLogoMutationOptions,
        success: "Added logo for Example Supply",
        invalidateKeys: expect.arrayContaining([["vendor"], ["search"]]),
      }),
    );
  });

  it("renders no action until a website is recorded", () => {
    const { container } = render(
      <VendorLogoFetchAction vendor={{ ...vendor, website: null }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a disabled pending state", () => {
    mocks.useProblemCardMutation.mockReturnValue({
      mutate: mocks.mutate,
      isPending: true,
    });

    render(<VendorLogoFetchAction vendor={vendor} />);

    expect(screen.getByRole("button", { name: "Fetching…" })).toBeDisabled();
  });
});
