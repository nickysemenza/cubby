import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { InspectableValue } from "./inspectable-value";

// A pointer focus must not cancel hover-to-click pinning; returning focus must not reopen Escape.
it("pins a hover preview for copying and supports keyboard inspection and dismissal", async () => {
  render(
    <>
      <InspectableValue value="checkpoint">
        Execution checkpoints
      </InspectableValue>
      <button>Outside</button>
    </>,
  );
  const trigger = screen.getByRole("button", { name: /Execution checkpoints/ });
  await userEvent.hover(trigger);
  await expect
    .element(page.getByText("checkpoint", { exact: true }))
    .toBeVisible();
  await userEvent.click(trigger);
  await userEvent.hover(screen.getByRole("button", { name: "Outside" }));
  await expect
    .element(page.getByText("checkpoint", { exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Copy raw value" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  await userEvent.click(trigger);
  await expect
    .element(page.getByText("checkpoint", { exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.tab({ shift: true });
  await expect
    .element(page.getByText("checkpoint", { exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
