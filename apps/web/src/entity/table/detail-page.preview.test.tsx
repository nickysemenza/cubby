import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { DetailSections } from "./detail-page";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

// The primary section is a card; the rest are ledger lines a link opens in
// place. A jump never costs a draft.
it("opens a ledger line through its fragment and keeps drafts", async () => {
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
  expect(screen.getByText("Source evidence body")).not.toBeVisible();
  await harness.router.navigate({ to: "/", hash: "source" });
  await waitFor(() =>
    expect(document.activeElement).toBe(document.getElementById("source")),
  );
  expect(screen.getByText("Source evidence body")).toBeVisible();
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
