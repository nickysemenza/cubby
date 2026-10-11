import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { TradeActivity } from "./trade-activity";

// Regression: a trade whose only activity is a credit (a discount with a typed
// trade) vanished from the chart once the adjustments footer was removed.
it("discloses credits that the spend bars cannot show", () => {
  render(
    <TradeActivity
      data={[
        {
          trade: "other",
          actual: 0,
          committed: 0,
          credits: 5,
          net: -5,
          count: 1,
        },
      ]}
    />,
  );
  expect(screen.getByText(/\$5 in credits/)).toBeVisible();
});
