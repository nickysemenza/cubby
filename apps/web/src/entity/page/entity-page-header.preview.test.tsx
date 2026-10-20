import { render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { usePageWorkbenchTarget } from "~/entity/page/page";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

import { DetailPageHeader, ListPageHeader } from "./entity-page-header";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

for (const width of [402, 900, 1280]) {
  it(`keeps detail identity and facts compact without clipping at ${width}px`, async () => {
    await page.viewport(width, 874);
    // The page inset the key-numbers strip bleeds into.
    render(
      <div className="px-2 md:px-4">
        <DetailPageHeader
          entity="product"
          title="Example utility lamp"
          heroNo="4K7M"
          heroStamp={{ label: "Ready" }}
          rawData={{ createdAt: "2026-01-01T12:00:00Z" }}
          heroActions={{ primary: <Button size="sm">Edit</Button> }}
          heroStats={[
            { label: "Value", value: "$48.00" },
            { label: "On hand", value: "3" },
          ]}
        />
      </div>,
      { wrapper: harness.wrapper },
    );
    const title = screen.getByRole("heading").getBoundingClientRect();
    const edit = screen
      .getByRole("button", { name: "Edit" })
      .getBoundingClientRect();
    const plate = screen
      .getByTestId("detail-spec-plate")
      .getBoundingClientRect();
    // The key-numbers strip below the identity has its own reflow budget.
    const strip = screen
      .getByTestId("detail-key-numbers")
      .getBoundingClientRect();
    const centersMatch =
      Math.abs(title.top + title.height / 2 - edit.top - edit.height / 2) <= 2;
    expect(centersMatch).toBe(width >= 640);
    expect(plate.height - strip.height).toBeLessThanOrEqual(
      width < 640 ? 164 : 120,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(screen.getByText("$48.00")).toBeVisible();
  });
}

it.each([
  {
    name: "a declared timestamp leads and the ingest time follows",
    entity: "email" as const,
    rawData: { receivedAt: "2026-08-13T17:41:19Z" },
    expected: /^Received Aug 13, 2026.*· added Oct 14, 2026/,
  },
  {
    name: "a declared date stays on its calendar day",
    entity: "purchase" as const,
    rawData: { date: "2026-08-13" },
    expected: /^Ordered Aug 13, 2026.*· added Oct 14, 2026/,
  },
  {
    name: "an empty declared time falls back to the ingest time",
    entity: "email" as const,
    rawData: { receivedAt: null },
    expected: /^Added Oct 14, 2026/,
  },
])("hero time: $name", ({ entity, rawData, expected }) => {
  render(
    <DetailPageHeader
      entity={entity}
      title="Example record"
      rawData={{ createdAt: "2026-10-15T02:26:59Z", ...rawData }}
    />,
    { wrapper: harness.wrapper },
  );
  const meta = screen.getByText(/added/i).closest("p");
  expect(meta?.textContent?.replace(/\s+/g, " ").trim()).toMatch(expected);
});

function QueryTools() {
  const target = usePageWorkbenchTarget();
  return target
    ? createPortal(
        <Input aria-label="Search products" className="h-8" />,
        target,
      )
    : null;
}

for (const width of [402, 900, 1280, 1800]) {
  it(`aligns the desktop workbench on one compact row and wraps phone tools at ${width}px`, async () => {
    await page.viewport(width, 874);
    render(
      <>
        <ListPageHeader
          chrome="workbench"
          title="Products"
          entity="product"
          count={248}
          actions={<Button size="sm">New</Button>}
          controls={
            <Button size="sm" variant="ghost">
              List
            </Button>
          }
        />
        <QueryTools />
      </>,
      { wrapper: harness.wrapper },
    );
    const title = screen.getByRole("heading").getBoundingClientRect();
    const action = screen
      .getByRole("button", { name: "New" })
      .getBoundingClientRect();
    const search = (await screen.findByRole("textbox")).getBoundingClientRect();
    const view = screen
      .getByRole("button", { name: "List" })
      .getBoundingClientRect();
    const desktop = width >= 768;
    const centers = [title, action, search, view].map(
      (rect) => rect.top + rect.height / 2,
    );
    const aligned = Math.max(...centers) - Math.min(...centers) <= 2;
    const searchPrecedesView = desktop
      ? search.left < view.left
      : view.top >= search.bottom;
    expect(aligned).toBe(desktop);
    expect(searchPrecedesView).toBe(true);
    expect(screen.getByText("248").closest("p")?.textContent).toBe(
      "248 products",
    );
    const band = document.querySelector("[data-workbench-band]")!;
    expect(band.getBoundingClientRect().height).toBeLessThanOrEqual(
      desktop ? 52 : 180,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
}
