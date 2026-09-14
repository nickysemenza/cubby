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
  });
});
