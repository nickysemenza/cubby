import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // Without a side column, sections share one full-width column in
    // declaration order.
    expect(document.querySelector("aside")).toBeNull();
    const facts = document.getElementById("facts")!.getBoundingClientRect();
    const support = document.getElementById("support")!.getBoundingClientRect();
    const body = document
      .getElementById("detail-group-overview")!
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

// Every group is on the page: a jump must never cost a draft or hide content.
it("shows every group, keeps drafts, and follows section links", async () => {
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
          content: <input aria-label="Review draft" />,
        },
        {
          id: "source",
          title: "Source evidence",
          icon: CircleIcon,
          placement: "full",
          group: "evidence",
          content: <p>Source evidence body</p>,
        },
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Review draft" }), {
    target: { value: "Unsaved review" },
  });
  expect(screen.getByText("Source evidence body")).toBeVisible();
  await harness.router.navigate({ to: "/", hash: "source" });
  await waitFor(() =>
    expect(document.activeElement).toBe(document.getElementById("source")),
  );
  expect(screen.getByRole("textbox", { name: "Review draft" })).toHaveValue(
    "Unsaved review",
  );
});

it("opens folded execution evidence through its fragment", async () => {
  await page.viewport(1280, 900);
  render(
    <DetailSections
      rawData={{}}
      sections={[
        {
          id: "execution-log",
          placement: "primary",
          title: "Execution log",
          icon: CircleIcon,
          group: "evidence",
          collapsed: true,
          content: <p>Recorded execution evidence</p>,
        },
      ]}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.queryByText("Recorded execution evidence")).toBeNull();
  await harness.router.navigate({ to: "/", hash: "execution-log" });
  await waitFor(() =>
    expect(screen.getByText("Recorded execution evidence")).toBeVisible(),
  );
});
