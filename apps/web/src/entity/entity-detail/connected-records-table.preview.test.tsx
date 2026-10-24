import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { ConnectionPaths } from "~/entity/relationships/connection-paths";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

it("contains long connection evidence inside a narrow relation column", async () => {
  await page.viewport(1200, 800);
  const { getByTestId } = render(
    <div
      data-testid="connection-cell"
      style={{ width: 280, overflow: "hidden" }}
    >
      <ConnectionPaths
        compact
        paths={[
          [
            {
              entityKind: "vendor",
              entityId: "VEN-TEST",
              label: "Example vendor",
            },
            {
              entityKind: "purchase",
              entityId: "PUR-TEST",
              label:
                "A very long synthetic purchase name that exceeds its column width by a lot",
            },
            {
              entityKind: "product",
              entityId: "PRD-TEST",
              label:
                "A very long synthetic product name that exceeds its column width by a lot",
            },
            {
              entityKind: "inventory",
              entityId: "INV-TEST",
              label: "Example item",
            },
          ],
          [
            {
              entityKind: "vendor",
              entityId: "VEN-TEST",
              label: "Example vendor",
            },
            {
              entityKind: "product",
              entityId: "PRD-OTHER",
              label: "Another synthetic product",
            },
            {
              entityKind: "inventory",
              entityId: "INV-TEST",
              label: "Example item",
            },
          ],
        ]}
      />
    </div>,
    { wrapper: harness.wrapper },
  );
  const cell = getByTestId("connection-cell");
  const toggle = cell.querySelector("button");
  if (!(toggle instanceof HTMLElement)) throw new Error("missing path toggle");
  expect(toggle.getBoundingClientRect().right).toBeLessThanOrEqual(
    cell.getBoundingClientRect().right + 1,
  );
  fireEvent.click(toggle);
  const path = cell.querySelector("ol");
  if (!(path instanceof HTMLElement))
    throw new Error("missing connection evidence");
  expect(path.getBoundingClientRect().right).toBeLessThanOrEqual(
    cell.getBoundingClientRect().right + 1,
  );
  expect(cell.querySelector('a[href="/purchases/PUR-TEST"]')).not.toBeNull();
  expect(cell.querySelector('a[href="/products/PRD-OTHER"]')).not.toBeNull();
});
