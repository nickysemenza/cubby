import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { fireEvent, render, screen } from "@testing-library/react";
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

for (const width of [560, 900, 1100, 1400]) {
  it(`stacks every section at full width on a ${width}px work surface`, async () => {
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
              placement: "primary",
              content: <p>Supporting evidence</p>,
            },
          ]}
        />
      </div>,
      { wrapper: harness.wrapper },
    );
    if (width >= 800)
      await screen.findByRole("navigation", { name: "Section index" });
    // A right rail squeezed record facts beside a second column; sections now
    // share one full-width column in declaration order.
    expect(document.querySelector("aside")).toBeNull();
    const facts = document.getElementById("facts")!.getBoundingClientRect();
    const support = document.getElementById("support")!.getBoundingClientRect();
    const body = document
      .querySelector("[data-detail-group]")!
      .getBoundingClientRect();
    expect(support.top).toBeGreaterThan(facts.top);
    for (const rect of [facts, support]) {
      // Only the section plane's hairline border may separate them.
      expect(rect.left - body.left).toBeLessThanOrEqual(1);
      expect(rect.width).toBeGreaterThanOrEqual(body.width - 2);
    }
    const section = document.getElementById("facts")!;
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
    expect(getComputedStyle(section.parentElement!).overflow).toBe("visible");
  });
}

// Hidden workspace bodies and folded reports made a continuous record unreadable;
// section navigation must keep every body and an in-progress draft available.
it("keeps all record sections open while jumping between groups", async () => {
  await page.viewport(1280, 900);
  render(
    <DetailSections
      rawData={{}}
      sections={[
        {
          id: "facts",
          title: "Facts",
          icon: CircleIcon,
          placement: "primary",
          content: <p>Record facts</p>,
        },
        {
          id: "review",
          title: "Review",
          icon: CircleIcon,
          placement: "full",
          workspace: "work",
          content: <input aria-label="Review draft" />,
        },
        {
          id: "evidence",
          title: "Source evidence",
          icon: CircleIcon,
          placement: "full",
          workspace: "evidence",
          content: <p>Source evidence body</p>,
        },
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByRole("textbox", { name: "Review draft" })).toBeVisible();
  expect(screen.getByText("Source evidence body")).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Review draft" }), {
    target: { value: "Unsaved review" },
  });
  fireEvent.click(await screen.findByRole("link", { name: "Source evidence" }));
  expect(document.activeElement).toBe(document.getElementById("evidence"));
  expect(screen.getByRole("textbox", { name: "Review draft" })).toHaveValue(
    "Unsaved review",
  );
});
