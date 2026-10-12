import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { Button } from "~/ui/primitives/button";

import { BasicInfo } from "./basic-info";

// Failure modes: captions always add height, actions drift with value lengths,
// and narrow dossiers let long facts paint beneath the action rail.
const action = (name: string) => (
  <Button variant="ghost" size="icon-xs" aria-label={name}>
    <InfoIcon className="size-3.5" />
  </Button>
);

it("keeps a short provenance caption inline and aligns fact actions", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 680 }}>
      <BasicInfo
        fields={[
          {
            label: "Manufacturer",
            value: "Example Foods",
            filterAction: action("Explain manufacturer"),
          },
          { label: "Model", value: "—", filterAction: action("Explain model") },
          {
            label: "Valuation price",
            value: <span data-testid="price">$4.80</span>,
            caption: (
              <span data-testid="caption">Expense-derived unit price</span>
            ),
            filterAction: action("Explain price"),
          },
        ]}
      />
    </div>,
  );
  const positions = screen
    .getAllByRole("button")
    .map((button) => button.getBoundingClientRect().right);
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(
    1,
  );
  const price = screen.getByTestId("price").getBoundingClientRect();
  const caption = screen.getByTestId("caption").getBoundingClientRect();
  expect(Math.abs(price.top - caption.top)).toBeLessThanOrEqual(2);
});

it("wraps a long fact within a narrow dossier without covering its actions", async () => {
  await page.viewport(402, 874);
  render(
    <div data-testid="dossier" style={{ width: 360 }}>
      <BasicInfo
        fields={[
          {
            label: "Manufacturer",
            value: (
              <span data-testid="value">
                Example manufacturer with a long descriptive name
              </span>
            ),
            filterAction: action("Explain manufacturer"),
          },
          {
            label: "Notes",
            value:
              "A longer prose fact that keeps the full available width for reading.",
            fullWidth: true,
          },
        ]}
      />
    </div>,
  );
  const dossier = screen.getByTestId("dossier");
  const value = screen.getByTestId("value").getBoundingClientRect();
  const button = screen.getByRole("button").getBoundingClientRect();
  expect(dossier.scrollWidth).toBeLessThanOrEqual(dossier.clientWidth);
  expect(value.right).toBeLessThanOrEqual(button.left);
  expect(button.height).toBeGreaterThanOrEqual(44);
});
