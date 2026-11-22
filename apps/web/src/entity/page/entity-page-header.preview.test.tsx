import { render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { usePageWorkbenchTarget } from "~/entity/page/page";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

import { ListPageHeader, RecordIdentity } from "./entity-page-header";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

it.each([
  {
    name: "a declared timestamp leads and the ingest time follows",
    entity: "email" as const,
    rawData: { receivedAt: "2026-08-13T17:41:19Z" },
    expected: /Received Aug 13, 2026.*added Oct 14, 2026/,
  },
  {
    name: "an empty declared time falls back to the ingest time",
    entity: "email" as const,
    rawData: { receivedAt: null },
    expected: /Added Oct 14, 2026/,
  },
])("hero time: $name", ({ entity, rawData, expected }) => {
  render(
    <RecordIdentity
      entity={entity}
      title="Example record"
      rawData={{ createdAt: "2026-10-15T02:26:59Z", ...rawData }}
    />,
    { wrapper: harness.wrapper },
  );
  const meta = screen.getByText(/added/i).parentElement;
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
