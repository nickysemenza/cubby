import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityEditDialog } from "./entity-edit-dialog";
import { entityEditBannerIssues } from "./entity-edit-dialog-content";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("EntityEditDialog", () => {
  it("mounts the real capture presentation when opened", async () => {
    render(
      <EntityEditDialog
        open
        onOpenChange={() => undefined}
        request={{ entity: "meal", operation: "create", intent: "capture" }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(await screen.findByText("New Meal")).toBeInTheDocument();
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("keeps field refusals beside their control while retaining every banner issue", () => {
    expect(
      entityEditBannerIssues([
        { message: "Meal cannot be saved", source: "server" },
        { field: "name", message: "Required", source: "server" },
        {
          message: "Recipes: 2 recipes still reference this meal.",
          source: "server",
        },
      ]),
    ).toEqual([
      "Meal cannot be saved",
      "Recipes: 2 recipes still reference this meal.",
    ]);
  });
});
