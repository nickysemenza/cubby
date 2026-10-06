import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RecordPaths } from "./connected-records-table";

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
      <RecordPaths
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
  const path = cell.querySelector("ol");
  const truncated = cell.querySelector(".truncate");
  if (!(path instanceof HTMLElement) || !(truncated instanceof HTMLElement))
    throw new Error("missing connection evidence");
  expect(path.getBoundingClientRect().right).toBeLessThanOrEqual(
    cell.getBoundingClientRect().right + 1,
  );
  expect(truncated.scrollWidth).toBeGreaterThan(truncated.clientWidth);
  expect(getComputedStyle(truncated).textOverflow).toBe("ellipsis");
  // A second path is a toggle on the trail's own line, not a line below it.
  const toggle = cell.querySelector("button");
  if (!(toggle instanceof HTMLElement)) throw new Error("missing path toggle");
  expect(toggle.getBoundingClientRect().top).toBeLessThan(
    path.getBoundingClientRect().bottom,
  );
  expect(toggle.getBoundingClientRect().right).toBeLessThanOrEqual(
    cell.getBoundingClientRect().right + 1,
  );
});
