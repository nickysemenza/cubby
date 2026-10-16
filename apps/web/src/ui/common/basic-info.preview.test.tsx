import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { Button } from "~/ui/primitives/button";

import { BasicInfo } from "./basic-info";
import { RecordList, RecordRow } from "./record-list";

// Failure modes: captions always add height, actions drift with value lengths,
// and narrow dossiers let long facts paint beneath the action rail.
const action = (name: string) => (
  <Button variant="ghost" size="icon-xs" aria-label={name}>
    <InfoIcon className="size-3.5" />
  </Button>
);

// A size-contained record list inside a flex fact value must fill the value
// column, or its dates and linked identities collapse to a few characters.
it("gives nested funding history the full fact value width", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 680 }}>
      <BasicInfo
        fields={[
          {
            label: "Funding periods",
            value: (
              <RecordList data-testid="funding-history">
                <RecordRow
                  primary={<a href="#household">Example household</a>}
                  secondary="… → 2024-04-30"
                  clip={false}
                />
                <RecordRow
                  primary={<a href="#member">Example member</a>}
                  secondary="2024-05-01 → …"
                  clip={false}
                />
              </RecordList>
            ),
          },
        ]}
      />
    </div>,
  );
  const list = screen.getByTestId("funding-history");
  const value = list.closest('[data-slot="basic-info-value"]')!;
  expect(list.getBoundingClientRect().width).toBeGreaterThanOrEqual(
    value.getBoundingClientRect().width - 1,
  );
  expect(
    screen.getByText("… → 2024-04-30").getBoundingClientRect().height,
  ).toBeLessThan(24);
});

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
  const label = screen.getByText("Manufacturer").getBoundingClientRect();
  expect(value.height).toBeGreaterThan(18);
  expect(
    Math.abs((label.top + label.bottom) / 2 - (button.top + button.bottom) / 2),
  ).toBeLessThanOrEqual(2);
});

it("centers short phone facts beside their touch controls", async () => {
  await page.viewport(402, 874);
  render(
    <div style={{ width: 360 }}>
      <BasicInfo
        fields={[
          {
            label: "Model",
            value: <span data-testid="phone-value">Example</span>,
            filterAction: action("Explain model"),
          },
        ]}
      />
    </div>,
  );
  const control = screen.getByRole("button").getBoundingClientRect();
  for (const text of [
    screen.getByText("Model"),
    screen.getByTestId("phone-value"),
  ]) {
    const bounds = text.getBoundingClientRect();
    expect(
      Math.abs(
        (bounds.top + bounds.bottom) / 2 - (control.top + control.bottom) / 2,
      ),
    ).toBeLessThanOrEqual(2);
  }
});
