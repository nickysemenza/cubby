import { problemsCountSchema } from "@cubby/schemas/problems";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { problems } from "~/lib/problems.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  ProblemsBanner,
  problemsBannerMessage,
  type ProblemsBannerOperations,
} from "./problems-banner";

const operations: ProblemsBannerOperations = {
  getCounts: problems.getCounts.withTransport(async () =>
    problemsCountSchema.parse({
      total: 2,
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

describe("ProblemsBanner", () => {
  it("shares the count descriptor and five-minute cache with the navbar", async () => {
    render(<ProblemsBanner isAuthed operations={operations} />, {
      wrapper: harness.wrapper,
    });

    expect(await screen.findByText("problems need attention")).toBeVisible();
    expect(screen.getByText("3 coverage gaps")).toBeVisible();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/problems");
  });

  it("does not claim everything checks out when coverage remains", () => {
    expect(problemsBannerMessage(0)).toBe("No defects found.");
  });
});
