import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { Image } from "~/ui/primitives/image";
import { NativeSelect } from "~/ui/primitives/native-select";

import { Ledger, LedgerCell, LedgerRow } from "./ledger";

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
