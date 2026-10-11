import { render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { usePageWorkbenchTarget } from "~/ui/page/Page";

import { WorkbenchBand } from "./workbench-band";

function QueryTools() {
  const target = usePageWorkbenchTarget();
  return target
    ? createPortal(<input aria-label="Search products" />, target)
    : null;
}

it.each([402, 1280])(
  "keeps identity and creation above query tools without page overflow at %ipx",
  async (width) => {
    await page.viewport(width, 874);
    render(
      <>
        <WorkbenchBand
          title="Products"
          count={248}
          countLabel="248 products"
          actions={<button type="button">New</button>}
          controls={<button type="button">List</button>}
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
    expect(action.top).toBeLessThan(title.bottom);
    expect(search.top).toBeGreaterThanOrEqual(title.bottom);
    expect(view.top).toBeGreaterThanOrEqual(title.bottom);
    const searchPrecedesView =
      width < 768 ? view.top >= search.bottom : search.left < view.left;
    expect(searchPrecedesView).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);
