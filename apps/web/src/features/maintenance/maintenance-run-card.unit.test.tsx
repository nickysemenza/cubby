import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  MaintenanceRunSummary,
  MaintenanceStatus,
} from "@cubby/schemas/maintenance";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entity/entity-query";
import { maintenance } from "~/integrations/tanstack-query/generated/domains/maintenance.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  MaintenanceRunCard,
  type MaintenanceRunOperations,
  maintenanceRefetchInterval,
} from "./maintenance-run-card";

const zeroImages = {
  current: 0,
  pending: 0,
  waiting: 0,
  skipped: 0,
  failed: 0,
  reviewNeeded: 0,
  remaining: 0,
};

const pass = (
  overrides: Partial<MaintenanceRunSummary> = {},
): MaintenanceRunSummary => ({
  runId: parseShortcodeFor("run", "RUN-4K7M"),
  status: "completed",
  trigger: "scheduled",
  startedAt: "2026-09-12T05:00:00.000Z",
  endedAt: "2026-09-12T05:41:00.000Z",
  failure: null,
  steps: 14,
  failedSteps: 0,
  current: null,
  ...overrides,
});

const status = (
  overrides: Partial<MaintenanceStatus> = {},
  backlog: Partial<MaintenanceStatus["backlog"]> = {},
): MaintenanceStatus => ({
  active: null,
  last: null,
  backlog: {
    staleImageMetadata: 0,
    originalsMissing: 0,
    metadataExtractionFailed: 0,
    staleRecipeTotals: 0,
    unembeddedEntities: 0,
    pendingUploads: 0,
    imageProcessing: { description: zeroImages, cutout: zeroImages },
    ...backlog,
  },
  computedAt: "2026-09-12T12:00:00.000Z",
  ...overrides,
});

function createOperations(read: MaintenanceStatus) {
  const launches: number[] = [];
  const statusOp = maintenance.status.withTransport(async () => read);
  const runOp = maintenance.run.withTransport(async () => {
    launches.push(Date.now());
    return {
      runId: parseShortcodeFor("run", "RUN-2222"),
      existing: false,
    };
  });
  return {
    launches,
    operations: {
      status: statusOp.queryOptions,
      run: runOp.mutationOptions,
    } satisfies MaintenanceRunOperations,
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

describe("MaintenanceRunCard", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
    const queryKey = entityPreviewQueryOptions("run", "RUN-4K7M").queryKey;
    harness.queryClient.setQueryDefaults(queryKey, { enabled: false });
    harness.queryClient.setQueryData(queryKey, {
      id: "RUN-4K7M",
      displayName: "Synthetic maintenance pass",
    });
  });
  afterEach(() => {
    harness.dispose();
  });

  it("shows the last pass, its failures and the waiting backlog", async () => {
    const { operations, launches } = createOperations(
      status(
        {
          last: pass({ status: "needs_review", failedSteps: 2 }),
        },
        { staleImageMetadata: 12, originalsMissing: 3 },
      ),
    );
    render(<MaintenanceRunCard operations={operations} />, {
      wrapper: harness.wrapper,
    });
    expect(
      await screen.findByText("2 steps with failures", { exact: false }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Backlog and image processing" }),
    );
    expect(screen.getByText(/awaiting EXIF\/GPS extraction/)).toBeVisible();
    expect(screen.getByText(/missing in storage/)).toBeVisible();
    expect(screen.queryByText(/awaiting a search embedding/)).toBeNull();
    // The pass names its Run through the shared record link, never a bare id.
    expect(
      await screen.findByRole("link", { name: /Synthetic maintenance pass/ }),
    ).toHaveAttribute("href", expect.stringContaining("RUN-4K7M"));
    expect(screen.queryByText(/RUN-4K7M/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(launches).toHaveLength(1));
  });

  it("disables Run now and shows the current step while a pass runs", async () => {
    const { operations } = createOperations(
      status({
        active: pass({
          status: "running",
          endedAt: null,
          current: {
            position: 3,
            label: "EXIF/GPS extraction",
            state: "running",
            found: 5560,
            done: 3840,
            failed: 0,
            skipped: 0,
            left: 1720,
            pausedReason: null,
            pausedUntil: null,
          },
        }),
      }),
    );
    render(<MaintenanceRunCard operations={operations} />, {
      wrapper: harness.wrapper,
    });
    expect(await screen.findByText(/Step 3 of 14/)).toBeInTheDocument();
    expect(screen.getByText("EXIF/GPS extraction")).toBeVisible();
    expect(screen.getByText(/1,720 left/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
  });

  it("polls only while a pass is active", () => {
    expect(maintenanceRefetchInterval(undefined)).toBe(false);
    expect(maintenanceRefetchInterval(status({ last: pass() }))).toBe(false);
    expect(
      maintenanceRefetchInterval(
        status({ active: pass({ status: "running" }) }),
      ),
    ).toBe(5_000);
  });
});
