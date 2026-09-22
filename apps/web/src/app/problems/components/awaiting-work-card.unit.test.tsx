import type {
  AwaitingWork,
  SettleAwaitingWorkOut,
} from "@cubby/schemas/maintenance";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { maintenance } from "~/lib/maintenance.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  AwaitingWorkCard,
  type AwaitingWorkOperations,
  awaitingWorkRefetchInterval,
} from "./awaiting-work-card";

const counts = (overrides: Partial<AwaitingWork> = {}): AwaitingWork => ({
  staleRecipeTotals: 0,
  unembeddedEntities: 0,
  pendingUploads: 0,
  computedAt: "2026-09-12T12:00:00.000Z",
  ...overrides,
});

function createOperations(
  awaiting: AwaitingWork | Error,
  settled: SettleAwaitingWorkOut = {
    publishedRecipeTasks: 0,
    publishedEmbeddingTasks: 0,
    culledUploads: 0,
    transport: "queue",
  },
) {
  const settles: number[] = [];
  const awaitingWork = maintenance.awaitingWork.withTransport(async () => {
    if (awaiting instanceof Error) throw awaiting;
    return awaiting;
  });
  const settleAwaitingWork = maintenance.settleAwaitingWork.withTransport(
    async () => {
      settles.push(1);
      return settled;
    },
  );
  return {
    operations: {
      awaitingWork: awaitingWork.queryOptions,
      settleAwaitingWork: settleAwaitingWork.mutationOptions,
    } satisfies AwaitingWorkOperations,
    settles,
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

describe("AwaitingWorkCard", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("lists only the non-zero counts and publishes on Settle now", async () => {
    const { operations, settles } = createOperations(
      counts({ staleRecipeTotals: 3, unembeddedEntities: 12 }),
      {
        publishedRecipeTasks: 1,
        publishedEmbeddingTasks: 12,
        culledUploads: 0,
        transport: "queue",
      },
    );
    render(<AwaitingWorkCard operations={operations} />, {
      wrapper: harness.wrapper,
    });

    expect(
      await screen.findByText(/awaiting cost \/ nutrition totals/),
    ).toBeInTheDocument();
    expect(screen.getByText(/awaiting a search embedding/)).toBeInTheDocument();
    expect(screen.queryByText(/abandoned more than a day/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settle now" }));
    await waitFor(() => expect(settles).toHaveLength(1));
  });

  it("says nothing is waiting instead of showing zeros", async () => {
    const { operations } = createOperations(counts());
    render(<AwaitingWorkCard operations={operations} />, {
      wrapper: harness.wrapper,
    });
    expect(await screen.findByText("Nothing waiting.")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("reports a failed read truthfully rather than as a clean card", async () => {
    const { operations } = createOperations(new Error("db down"));
    render(<AwaitingWorkCard operations={operations} />, {
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
