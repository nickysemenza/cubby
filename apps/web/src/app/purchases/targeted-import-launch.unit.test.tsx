import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { TargetedImportLaunchDialog } from "./targeted-import-launch";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
});

describe("TargetedImportLaunchDialog", () => {
  it("defaults to browser evidence and links a busy account's blocking run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("?") && url.includes("purpose=purchase_validation")) {
          return Promise.resolve(
            Response.json({
              purpose: "purchase_validation",
              purchase: {
                id: "PUR-ABCDE12345",
                label: "Fixture order",
                canValidate: true,
                reason: null,
                sources: [
                  {
                    id: "source-browser-order",
                    label: "Browser order #fixture",
                    kind: "browser_order",
                    fingerprint: "abc",
                    vendorAccountId: "VACCT-ABCDE12345",
                    vendorAccountLabel: "Fixture account",
                    usable: true,
                    reason: null,
                    default: true,
                  },
                ],
                products: [],
              },
              products: [],
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            runs: [
              {
                created: false,
                run: null,
                blockingRun: { id: "RUN-4K7M", status: "running" },
              },
            ],
          }),
        );
      }),
    );

    render(
      <TargetedImportLaunchDialog
        open
        onOpenChange={vi.fn()}
        targetId="PUR-ABCDE12345"
        targetLabel="Fixture order"
        purpose="purchase_validation"
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("radio", { name: /Browser order #fixture/ }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Start validation" }));
    expect(
      await screen.findByText("One account is already busy"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open RUN-4K7M/ })).toHaveAttribute(
      "href",
      "/purchase-imports/RUN-4K7M",
    );
  });
});
