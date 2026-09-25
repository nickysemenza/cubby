import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { TargetedImportLaunchDialog } from "./targeted-import-launch";

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: (() => void) | undefined;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  restoreDispatch?.();
  harness.dispose();
});

describe("TargetedImportLaunchDialog", () => {
  it("defaults to browser evidence and links a busy account's blocking run", async () => {
    restoreDispatch = overrideStartDispatch(async (operation) => {
      if (operation === "run.targetedLaunch")
        return {
          ok: true,
          data: {
            purpose: "purchase_validation",
            purchase: {
              id: "PUR-4K7M",
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
          },
        };
      return {
        ok: true,
        data: {
          runs: [
            {
              created: false,
              run: null,
              blockingRun: { id: "RUN-4K7M", status: "running" },
            },
          ],
        },
      };
    });

    render(
      <TargetedImportLaunchDialog
        open
        onOpenChange={vi.fn()}
        targetId="PUR-4K7M"
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
      "/runs/RUN-4K7M",
    );
  });
});
