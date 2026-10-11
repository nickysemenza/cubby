import { render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { usePageWorkbenchTarget } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

import { WorkbenchBand } from "./workbench-band";

function QueryTools() {
  const target = usePageWorkbenchTarget();
  return target
    ? createPortal(
        <Input aria-label="Search products" dense className="h-8" />,
        target,
      )
    : null;
}

for (const width of [402, 900, 1280, 1800]) {
  it(`aligns the desktop workbench on one compact row and wraps phone tools at ${width}px`, async () => {
    await page.viewport(width, 874);
    render(
      <>
        <WorkbenchBand
          title="Products"
          count={248}
          countLabel="248 products"
          actions={<Button size="sm">New</Button>}
          controls={
            <Button size="sm" variant="ghost">
              List
            </Button>
          }
        />
        <QueryTools />
      </>,
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
    const band = document.querySelector("[data-workbench-band]")!;
    expect(band.getBoundingClientRect().height).toBeLessThanOrEqual(
      desktop ? 52 : 180,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
}
