import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { Image } from "~/ui/primitives/image";
import { NativeSelect } from "~/ui/primitives/native-select";

import { Ledger, LedgerCell, LedgerRow } from "./ledger";

it("retains readable photo evidence when an image fails", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 540 }}>
      <Ledger>
        <LedgerRow>
          <LedgerCell slot="leading">
            <Image
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='160'/%3E"
              alt="Synthetic reviewed photo"
              unoptimized
              className="h-40 w-32"
            />
          </LedgerCell>
          <LedgerCell slot="primary">
            Synthetic reviewed photo record with retained evidence
          </LedgerCell>
          <LedgerCell slot="secondary" data-testid="failed-photo-evidence">
            Source evidence remains readable when the photo is unavailable.
          </LedgerCell>
          <LedgerCell slot="trailing">Oct 11, 12:38 PM</LedgerCell>
        </LedgerRow>
      </Ledger>
    </div>,
  );
  fireEvent.error(screen.getByAltText("Synthetic reviewed photo"));
  expect(
    screen.getByRole("img", { name: "Synthetic reviewed photo" }).tagName,
  ).toBe("DIV");
  const evidence = screen
    .getByTestId("failed-photo-evidence")
    .getBoundingClientRect();
  const title = screen
    .getByText("Synthetic reviewed photo record with retained evidence")
    .getBoundingClientRect();
  expect(evidence.width).toBeGreaterThanOrEqual(240);
  expect(evidence.top).toBeGreaterThanOrEqual(title.bottom);
});

// A photo, title, timestamp and choice can exhaust the tracks at an intermediate
// container width. Choice controls must retain usable width beneath identity.
it("keeps photo-report choices readable in a 540px container", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 540 }} data-testid="report">
      <Ledger>
        <LedgerRow>
          <LedgerCell slot="leading">
            <Image
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='160'/%3E"
              alt="Synthetic product"
              displayWidth={128}
              className="h-40 w-32"
            />
          </LedgerCell>
          <LedgerCell slot="primary">
            A descriptive product title with retained source evidence
          </LedgerCell>
          <LedgerCell as="div" slot="secondary" data-testid="choice">
            <label htmlFor="matching-product">
              Choose a matching product
              <NativeSelect id="matching-product" aria-label="Matching product">
                <option>Keep the proposed match</option>
                <option>Choose another match</option>
              </NativeSelect>
            </label>
          </LedgerCell>
          <LedgerCell slot="trailing">Oct 11, 12:38:54 PM</LedgerCell>
        </LedgerRow>
      </Ledger>
    </div>,
  );
  const report = screen.getByTestId("report");
  const choice = screen.getByTestId("choice").getBoundingClientRect();
  const title = screen
    .getByText("A descriptive product title with retained source evidence")
    .getBoundingClientRect();
  expect(choice.width).toBeGreaterThanOrEqual(240);
  expect(choice.top).toBeGreaterThanOrEqual(title.bottom);
  expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth);
});

it("keeps expanded action forms beneath the check in a popover", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 540 }} data-testid="exception-report">
      <Ledger>
        <LedgerRow>
          <LedgerCell slot="primary">Manufacturer identity</LedgerCell>
          <LedgerCell slot="secondary">Missing data</LedgerCell>
          <LedgerCell slot="trailing" data-testid="exception-state">
            Ready
          </LedgerCell>
          <LedgerCell slot="actions" as="div" data-testid="exception-form">
            <form>
              <label htmlFor="exception-reason">
                Reason
                <NativeSelect id="exception-reason">
                  <option>Not applicable</option>
                </NativeSelect>
              </label>
              <label htmlFor="exception-note">
                Note
                <input id="exception-note" aria-label="Note" />
              </label>
              <button type="button">Accept exception</button>
            </form>
          </LedgerCell>
        </LedgerRow>
      </Ledger>
    </div>,
  );
  const report = screen.getByTestId("exception-report");
  const form = screen.getByTestId("exception-form").getBoundingClientRect();
  const check = screen
    .getByText("Manufacturer identity")
    .getBoundingClientRect();
  expect(form.top).toBeGreaterThanOrEqual(check.bottom);
  expect(form.width).toBeGreaterThanOrEqual(320);
  expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth);
  const state = screen.getByTestId("exception-state").getBoundingClientRect();
  expect(
    report.getBoundingClientRect().right - state.right,
  ).toBeLessThanOrEqual(1);
});

it("keeps compact action controls beside their record", async () => {
  await page.viewport(1440, 900);
  render(
    <div style={{ width: 540 }}>
      <Ledger>
        <LedgerRow>
          <LedgerCell slot="primary">Synthetic record</LedgerCell>
          <LedgerCell slot="trailing">Ready</LedgerCell>
          <LedgerCell as="div" slot="actions">
            <NativeSelect aria-label="Compact action">
              <option>Review</option>
            </NativeSelect>
          </LedgerCell>
        </LedgerRow>
      </Ledger>
    </div>,
  );
  const action = screen.getByRole("combobox").getBoundingClientRect();
  const record = screen.getByText("Synthetic record").getBoundingClientRect();
  expect(action.top).toBeLessThan(record.bottom);
  expect(action.bottom).toBeGreaterThan(record.top);
});

// Regression: a report slot stacked its blocks with `items-start`, so the
// inline-size container measured only its widest sibling and the narrow grid
// broke a block title one character per line.
it("fills a start-aligned column instead of shrinking to a sibling", async () => {
  await page.viewport(1440, 900);
  render(
    <div
      style={{
        width: 600,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
      }}
    >
      <Ledger data-testid="usage">
        <LedgerRow>
          <LedgerCell slot="primary">Synthetic model usage title</LedgerCell>
          <LedgerCell slot="trailing">12:38 PM</LedgerCell>
        </LedgerRow>
      </Ledger>
      <span>Subtotal</span>
    </div>,
  );
  const ledger = screen.getByTestId("usage").getBoundingClientRect();
  const title = screen
    .getByText("Synthetic model usage title")
    .getBoundingClientRect();
  expect(ledger.width).toBeGreaterThanOrEqual(599);
  expect(title.height).toBeLessThan(24);
});

// Regression: Similar products rendered rows with no Ledger, so subgrid fell
// back to implicit columns and every row aligned differently.
it("refuses a row rendered outside a ledger", () => {
  expect(() =>
    render(
      <ul>
        <LedgerRow>
          <LedgerCell slot="primary">Orphan row</LedgerCell>
        </LedgerRow>
      </ul>,
    ),
  ).toThrow(/inside a Ledger/);
});
