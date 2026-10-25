import { deviceOut } from "@cubby/schemas/device";
import { shortcode } from "@cubby/schemas/identifiers";
import { runOut } from "@cubby/schemas/run";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { JobFacts, QueueHealthSnapshot } from "~/contracts/job.contract";
import { installFeatures } from "~/features/registry";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";

import { QueueOverview, type QueueSearch } from "./queue-overview";

installFeatures();

const RUN_ID = shortcode("RUN-4K7M");
const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

const leasedJob: JobFacts = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "image-processing:00000000-0000-4000-8000-000000000002",
  kind: "image.device",
  state: "running",
  generation: 1,
  attempts: 0,
  maxAttempts: 3,
  priority: 0,
  waitReason: null,
  waitUntil: null,
  availableAt: at(-5),
  leaseExpiresAt: at(-1),
  error: null,
  cursor: null,
  subject: null,
  createdAt: at(-10),
  updatedAt: at(-2),
  ahead: null,
  lane: "apple_device",
  waitingOn: {
    reason: "leased",
    lane: "apple_device",
    executor: "Fixture iPad",
    executorDeviceId: null,
    leasedAt: at(-3),
    leaseExpiresAt: at(-1),
    expired: true,
  },
  runId: RUN_ID,
};

const queue = {
  counts: [
    { lane: "apple_device", reason: "waiting_device", count: 41 },
    { lane: "apple_device", reason: "leased", count: 3 },
    { lane: "frontier_ai", reason: "waiting_funding", count: 12 },
  ],
  total: 56,
  leases: [
    { executor: "Fixture iPad", live: 0, expired: 1 },
    { executor: "Fixture Mac", live: 2, expired: 0 },
  ],
  jobs: [leasedJob],
};

const health: QueueHealthSnapshot = {
  measuredAt: at(-1),
  kinds: [],
  imageDisagreement: 4,
  alerts: [
    {
      kind: "image.device",
      code: "expired_leases",
      evidence: "17 expired leases (threshold 10)",
    },
  ],
};

// List rows carry their display images beside the record fields.
const listRow = <T extends object>(record: T) => ({
  ...record,
  displayImages: [],
});

const runPage = <T,>(items: T[]) => ({
  items,
  meta: { pageIndex: 0, pageSize: 50, totalCount: items.length },
});

// Running Runs: only the stalled one needs attention.
const runningRuns = runPage([
  listRow(
    mock(runOut, {
      overrides: {
        id: RUN_ID,
        displayName: "Fixture member · Photo inventory",
        status: "running",
        displayStatus: "running",
        stalled: true,
        waitingOn: "41 waiting for any Apple device",
      },
    }),
  ),
  listRow(
    mock(runOut, {
      overrides: {
        id: shortcode("RUN-4K7P"),
        displayName: "Fixture member · Account sync",
        status: "running",
        displayStatus: "running",
        stalled: false,
      },
    }),
  ),
]);

// The declared attention view's rows, failures included.
const stoppedRuns = runPage([
  listRow(
    mock(runOut, {
      overrides: {
        id: shortcode("RUN-4K7N"),
        displayName: "Fixture member · Mail import",
        status: "needs_review",
        displayStatus: "retried",
      },
    }),
  ),
  listRow(
    mock(runOut, {
      overrides: {
        id: shortcode("RUN-4K7Q"),
        displayName: "Fixture member · Failed import",
        status: "failed",
        displayStatus: "failed",
        stalled: false,
      },
    }),
  ),
  listRow(
    mock(runOut, {
      overrides: {
        id: shortcode("RUN-4K7R"),
        displayName: "Fixture member · Undelivered import",
        status: "dispatch_failed",
        displayStatus: "dispatch_failed",
        stalled: false,
      },
    }),
  ),
]);
const runFilters: unknown[] = [];

const devices = {
  items: [
    listRow(
      mock(deviceOut, { overrides: { inactive: false, updateRequired: true } }),
    ),
    listRow(mock(deviceOut, { overrides: { inactive: true } })),
  ],
  meta: { pageIndex: 0, pageSize: 50, totalCount: 2 },
};

const answers = new Map<string, UnparsedStartOperationData>([
  ["job.queue", queue],
  ["job.health", { snapshot: health }],
  ["job.retryNow", { retried: 53 }],
  [
    "job.explain",
    {
      steps: [
        {
          ref: leasedJob.id,
          kind: "job",
          label: "image.device · fixture",
          state: "running",
          waitingOn: leasedJob.waitingOn,
          detail: null,
        },
      ],
      rollup: null,
    },
  ],
]);

let harness: ReturnType<typeof createBrowserTestHarness>;
let restore: (() => void) | undefined;
const retried: unknown[] = [];

beforeEach(async () => {
  await page.viewport(1440, 1200);
  harness = createBrowserTestHarness();
  retried.length = 0;
  runFilters.length = 0;
  restore = overrideStartDispatch(async (operation, input) => {
    if (operation === "job.retryNow") retried.push(input);
    if (operation === "entity.list") {
      const { entity, filters } = input as {
        entity?: string;
        filters?: { status?: string[] };
      };
      if (entity === "device") return { ok: true, data: devices };
      runFilters.push(filters);
      return {
        ok: true,
        data: filters?.status?.join() === "running" ? runningRuns : stoppedRuns,
      };
    }
    const data = answers.get(operation);
    if (data === undefined) throw new Error(`${operation} is not stubbed`);
    return { ok: true, data };
  });
});

afterEach(() => {
  restore?.();
  harness.dispose();
});

const renderOverview = (search: QueueSearch = {}) =>
  render(<QueueOverview search={search} onSearchChange={() => {}} />, {
    wrapper: harness.wrapper,
  });

it("groups the queues by lane and reason, flags expired leases and the watchdog", async () => {
  renderOverview();

  const alert = await screen.findByTestId("queue-health");
  expect(alert).toHaveTextContent("Queue unhealthy · 1 alert");
  expect(alert).toHaveTextContent("17 expired leases (threshold 10)");

  const reason = await screen.findByRole("link", {
    name: "Waiting for any Apple device",
  });
  expect(reason.getAttribute("href")).toContain("lane=apple_device");
  expect(reason.getAttribute("href")).toContain("reason=waiting_device");
  expect(screen.getByText("Waiting for AI funding")).toBeVisible();
  // Inactive installs leave the device count.
  expect(
    await screen.findByText("1 active Apple device · 1 need an update"),
  ).toBeVisible();
  expect(screen.getByText("1 expired lease")).toBeVisible();
  expect(screen.getByText("Fixture Mac").closest("li")).toHaveTextContent(
    "Fixture Mac2 in progress",
  );

  // The declared attention view (failures included) plus stalled running
  // Runs; a retried Run and a healthy running one leave the list.
  await expect
    .poll(() => screen.queryAllByTestId("attention-run").length)
    .toBe(3);
  const attention = screen.getAllByTestId("attention-run");
  expect(attention.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Failed import"),
    expect.stringContaining("Undelivered import"),
    expect.stringContaining("Stalled"),
  ]);
  expect(runFilters).toContainEqual(
    expect.objectContaining({
      status: [
        "paused",
        "paused_auth",
        "needs_review",
        "failed",
        "dispatch_failed",
      ],
    }),
  );

  const row = (await screen.findAllByTestId("queue-job"))[0]!;
  expect(row).toHaveTextContent("Lease expired");
  expect(row).toHaveTextContent(
    "Lease on Fixture iPad expired; waiting to be reclaimed",
  );
});

it("confirms Retry now over the filtered set", async () => {
  renderOverview({ lane: "apple_device", reason: "waiting_device" });

  await userEvent.click(
    await screen.findByRole("button", { name: "Retry now" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Retry 56 Jobs now?");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Retry now" }),
  );

  await expect.poll(() => retried).toHaveLength(1);
  expect(retried[0]).toMatchObject({
    filter: { lanes: ["apple_device"], reasons: ["waiting_device"] },
  });
});
