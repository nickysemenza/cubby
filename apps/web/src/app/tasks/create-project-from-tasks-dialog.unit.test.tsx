import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CreateProjectFromTasksDialog } from "./create-project-from-tasks-dialog";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("CreateProjectFromTasksDialog", () => {
  it("renders", () => {
    render(
      <CreateProjectFromTasksDialog
        open
        onOpenChange={() => {}}
        taskIds={[testShortcode("task", "TSK-4K7M")]}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("button", { name: "Create" })).toBeVisible();
    const form = screen.getByRole("button", { name: "Create" }).closest("form");
    const body = form?.querySelector('[data-slot="dialog-form-body"]');
    const footer = form?.querySelector('[data-slot="dialog-form-footer"]');
    expect(body).toBeTruthy();
    expect(footer).toContainElement(
      screen.getByRole("button", { name: "Create" }),
    );
    expect(body).not.toContainElement(
      screen.getByRole("button", { name: "Create" }),
    );
  });
});
