import type { ClassifyImageProvenanceOut } from "@cubby/schemas/maintenance";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { maintenance } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ImageProvenanceAction } from "./maintenance-card";

const cursorOne = "00000000-0000-4000-8000-000000000001";
const cursorTwo = "00000000-0000-4000-8000-000000000002";

function page(nextCursor: string | null): ClassifyImageProvenanceOut {
  return {
    dryRun: false,
    batches: 1,
    scanned: 25,
    classified: 1,
    capturedAtSeeded: 0,
    unresolved: 24,
    remaining: 25,
    nextCursor,
    stopped: "limit",
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

describe("ImageProvenanceAction", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });

  afterEach(() => {
    harness.dispose();
  });

  it("keeps preview and apply cursors separate and continues each from its own cursor", async () => {
    const calls: Array<{ dryRun: boolean; afterId?: string }> = [];
    const classify = maintenance.classifyImageProvenance.withTransport(
      async ({ input }) => {
        calls.push(input);
        if (input.dryRun) {
          return page(
            calls.filter((call) => call.dryRun).length === 1 ? cursorOne : null,
          );
        }
        return page(
          calls.filter((call) => !call.dryRun).length === 1 ? cursorTwo : null,
        );
      },
    );

    render(
      <ImageProvenanceAction
        operations={{ classifyImageProvenance: classify.mutationOptions }}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls).toHaveLength(4));

    expect(calls.map(({ dryRun, afterId }) => ({ dryRun, afterId }))).toEqual([
      { dryRun: true, afterId: undefined },
      { dryRun: true, afterId: cursorOne },
      { dryRun: false, afterId: undefined },
      { dryRun: false, afterId: cursorTwo },
    ]);
  });

  it("shows raw classification errors in an alert", async () => {
    const classify = maintenance.classifyImageProvenance.withTransport(
      async () => {
        throw new Error(
          "Decision gateway returned HTTP 503: upstream unavailable",
        );
      },
    );

    render(
      <ImageProvenanceAction
        operations={{ classifyImageProvenance: classify.mutationOptions }}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision gateway returned HTTP 503: upstream unavailable",
    );
  });
});
