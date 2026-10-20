import { problemsCountSchema } from "@cubby/schemas/problems";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { problems } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ProblemsRow, type ProblemsRowOperations } from "./problems-row";

const operations: ProblemsRowOperations = {
  getCounts: problems.getCounts.withTransport(async () =>
    problemsCountSchema.parse({
      total: 2,
      autoFixTotal: 0,
      coverageTotal: 3,
      byType: Object.fromEntries(
        Object.keys(problemsCountSchema.shape.byType.shape).map((key) => [
          key,
          0,
        ]),
      ),
    }),
  ),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("ProblemsRow", () => {
  it("shares the count descriptor and five-minute cache with the navbar", async () => {
    render(
      <ul>
        <ProblemsRow isAuthed operations={operations} />
      </ul>,
      {
        wrapper: harness.wrapper,
      },
    );

    expect(await screen.findByText("problems need attention")).toBeVisible();
    expect(screen.getByText("3 coverage gaps")).toBeVisible();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/problems");
  });

  it("says the count is unknown when the read fails instead of hiding", async () => {
    const failing: ProblemsRowOperations = {
      getCounts: problems.getCounts.withTransport(async () => {
        throw new Error("synthetic count failure");
      }),
    };
    render(
      <ul>
        <ProblemsRow isAuthed operations={failing} />
      </ul>,
      {
        wrapper: harness.wrapper,
      },
    );

    expect(
      await screen.findByText("Couldn't load problem counts:"),
    ).toBeVisible();
    expect(screen.getByText("synthetic count failure")).toBeVisible();
  });
});
