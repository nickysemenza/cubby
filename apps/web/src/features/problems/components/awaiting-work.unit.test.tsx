import type { AwaitingWork } from "@cubby/schemas/maintenance";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { maintenance } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  AwaitingWorkList,
  type AwaitingWorkOperations,
  awaitingWorkRefetchInterval,
} from "./awaiting-work";

const counts = (overrides: Partial<AwaitingWork> = {}): AwaitingWork => ({
  staleRecipeTotals: 0,
  unembeddedEntities: 0,
  pendingUploads: 0,
  staleImageMetadata: 0,
  computedAt: "2026-09-12T12:00:00.000Z",
  ...overrides,
});

function createOperations(awaiting: AwaitingWork | Error) {
  const awaitingWork = maintenance.awaitingWork.withTransport(async () => {
    if (awaiting instanceof Error) throw awaiting;
    return awaiting;
  });
  return {
    operations: {
      awaitingWork: awaitingWork.queryOptions,
    } satisfies AwaitingWorkOperations,
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

describe("AwaitingWorkList", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("shows pending work as passive diagnostics", async () => {
    const { operations } = createOperations(
      counts({ staleRecipeTotals: 3, unembeddedEntities: 12 }),
    );
    render(<AwaitingWorkList operations={operations} />, {
      wrapper: harness.wrapper,
    });

    expect(
      await screen.findByText(/awaiting cost \/ nutrition totals/),
    ).toBeInTheDocument();
    expect(screen.getByText(/awaiting a search embedding/)).toBeInTheDocument();
    expect(screen.queryByText(/abandoned more than a day/)).toBeNull();

    expect(screen.queryByRole("button", { name: "Settle now" })).toBeNull();
  });

  it("says nothing is waiting instead of showing zeros", async () => {
    const { operations } = createOperations(counts());
    render(<AwaitingWorkList operations={operations} />, {
      wrapper: harness.wrapper,
    });
    expect(await screen.findByText("Nothing waiting.")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("reports a failed read truthfully rather than as a clean card", async () => {
    const { operations } = createOperations(new Error("db down"));
    render(<AwaitingWorkList operations={operations} />, {
      wrapper: harness.wrapper,
    });
    expect(await screen.findByText("db down")).toBeInTheDocument();
    expect(screen.queryByText("Nothing waiting.")).toBeNull();
  });

  it("polls only while something is waiting", () => {
    expect(awaitingWorkRefetchInterval(undefined)).toBe(false);
    expect(awaitingWorkRefetchInterval(counts())).toBe(false);
    expect(awaitingWorkRefetchInterval(counts({ pendingUploads: 1 }))).toBe(
      15_000,
    );
  });
});
