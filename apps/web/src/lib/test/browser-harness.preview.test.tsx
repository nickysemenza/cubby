import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { createBrowserTestHarness } from "./browser-harness";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => harness?.dispose());

// Native capability tests cannot inherit jsdom's fixed geometry, false media
// queries or no-op scrolling through their shared query/router providers.
it("preserves responsive layout and real scrolling inside browser providers", async () => {
  await page.viewport(402, 874);
  harness = createBrowserTestHarness();
  const screen = render(
    <div
      data-testid="scroll-region"
      style={{ width: 240, height: 80, overflow: "auto" }}
    >
      <div style={{ paddingTop: 400 }}>
        <button type="button">Synthetic scroll target</button>
      </div>
    </div>,
    { wrapper: harness.wrapper },
  );
  const region = screen.getByTestId("scroll-region");
  expect(region.clientWidth).toBe(240);
  expect(window.matchMedia("(max-width: 600px)").matches).toBe(true);
  screen
    .getByRole("button", { name: "Synthetic scroll target" })
    .scrollIntoView({ block: "nearest" });
  await waitFor(() => expect(region.scrollTop).toBeGreaterThan(0));
});
