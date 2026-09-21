import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import BulkInventoryForm from "./bulk-inventory-form";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

describe("bulk inventory edit", () => {
  it("opens the location picker without a deep-linked location", () => {
    render(<BulkInventoryForm />, { wrapper: harness.wrapper });
    expect(screen.getByRole("combobox", { name: "Location" })).toBeVisible();
    expect(harness.queryClient.isFetching()).toBe(0);
  });
});
