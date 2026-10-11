import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { Button } from "~/ui/primitives/button";

import { DetailSections } from "./detail-page";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

for (const width of [560, 1000]) {
  it(`fits the primary and supporting sections to a ${width}px work surface`, async () => {
    await page.viewport(1280, 900);
    render(
      <div style={{ width }}>
        <DetailSections
          rawData={{}}
          sections={[
            {
              id: "facts",
              title: "Important descriptive record facts",
              icon: CircleIcon,
              placement: "primary",
              overflowVisible: true,
              headerAction: <Button size="sm">Add related record</Button>,
              content: <p>Primary facts</p>,
            },
            {
              id: "support",
              title: "Supporting facts",
              icon: CircleIcon,
              placement: "supporting",
              content: <p>Supporting evidence</p>,
            },
          ]}
        />
      </div>,
      { wrapper: harness.wrapper },
    );
    const primary = screen
      .getByTestId("detail-primary-stack")
      .getBoundingClientRect();
    const rail = screen
      .getByTestId("detail-supporting-rail")
      .getBoundingClientRect();
    expect(rail.left > primary.left).toBe(width >= 800);
    expect(primary.width).toBeGreaterThanOrEqual(width < 800 ? width - 2 : 600);
    const section = document.getElementById("facts")!;
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
    expect(getComputedStyle(section.parentElement!).overflow).toBe("visible");
  });
}
