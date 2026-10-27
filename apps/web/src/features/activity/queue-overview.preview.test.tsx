import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { shortcode } from "@cubby/schemas/identifiers";
import { jobOut } from "@cubby/schemas/job-entity";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { z } from "zod";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { getEntityDetailOutputSchema } from "~/entity/generated/entity-details.gen";
import { installFeatures } from "~/features/registry";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { QueueOverview, type QueueSearch } from "./queue-overview";

installFeatures();
const runOut = entityFieldEnvelopeSchemas.run.detail;
const code = shortcode("JOB-4K7MN4K7MN");
const run = mock(runOut, {
  overrides: {
    fields: {
      displayStatus: fieldValueFixture(
        entityFieldEnvelopeSchemas.run.detail.shape.fields.shape[
          "displayStatus"
        ],
        "running",
      ),
      stalled: fieldValueFixture(
        entityFieldEnvelopeSchemas.run.detail.shape.fields.shape["stalled"],
        true,
      ),
      waitingOn: fieldValueFixture(
        entityFieldEnvelopeSchemas.run.detail.shape.fields.shape["waitingOn"],
        "3 waiting for any Apple device",
      ),
    },
    id: shortcode("RUN-4K7MN"),
    displayName: "Synthetic photo Run",
    purpose: "photo_inventory",
    status: "running",
  },
});
const work = mock(jobOut, {
  overrides: {
    id: code,
    kind: "image.device",
    fields: {
      lane: fieldValueFixture(jobOut.shape.fields.shape.lane, "apple_device"),
      waitingOn: fieldValueFixture(
        jobOut.shape.fields.shape.waitingOn,
        "Waiting for any Apple device",
      ),
      runName: fieldValueFixture(
        jobOut.shape.fields.shape.runName,
        run.displayName,
      ),
    },
    state: "queued",
    runId: run.id,
    imageId: null,
    locationId: null,
    error: "Synthetic retained diagnostic",
    attempts: 0,
  },
});
const inputSchema = z.looseObject({ entity: z.string().optional() });
const reads: unknown[] = [];
const retried: unknown[] = [];
let harness: ReturnType<typeof createBrowserTestHarness>;
let restore: (() => void) | undefined;
let quiet = false;
let backlogFails = false;
let failuresOnly = false;
let measuredAt = Date.now();

beforeEach(async () => {
  await page.viewport(1440, 1200);
  quiet = false;
  backlogFails = false;
  failuresOnly = false;
  measuredAt = Date.now();
  reads.length = 0;
  retried.length = 0;
  // Foreign page filters/sort must never leak into either embedded list.
  harness = createBrowserTestHarness({
    initialPath: "/?kind=foreign&sort=-date",
  });
  restore = overrideStartDispatch(async (operation, input) => {
    if (operation === "entity.list") {
      reads.push(input);
      const { entity } = inputSchema.parse(input);
      return {
        ok: true,
        data: {
          // Complete rows carry their media.
          items: (entity === "run" ? [run] : [work]).map((row) => ({
            ...row,
            fields: {
              ...row.fields,
              displayImages: fieldValueFixture(
                entityFieldEnvelopeSchemas.job.detail.shape.fields.shape
                  .displayImages,
                [],
              ),
            },
          })),
          meta: {
            pageIndex: 0,
            pageSize: entity === "run" ? 10 : 25,
            totalCount: entity === "run" ? 12 : 31,
          },
        },
      };
    }
    if (operation === "derived.backlog") {
      if (backlogFails) throw new Error("Synthetic backlog read failure");
      return {
        ok: true,
        data: {
          total: 0,
          kinds: [],
          oldestWaitingSeconds: null,
          recent: { windowMinutes: 15, perMinute: [] },
        },
      };
    }
    if (operation === "entity.detail")
      return {
        ok: true,
        data: mock(getEntityDetailOutputSchema("job"), {
          overrides: {
            ...work,
            fields: {
              ...work.fields,
              displayImages: fieldValueFixture(
                entityFieldEnvelopeSchemas.job.detail.shape.fields.shape
                  .displayImages,
                [],
              ),
            },
            attachments: [],
            redirectedFrom: null,
            previousShortcodes: [],
          },
        }),
      };
    if (operation === "suggestions.recordCounts")
      return { ok: true, data: { records: [] } };
    if (operation === "entityMedia.displayImages")
      return { ok: true, data: {} };
    if (operation === "entity.graph")
      return {
        ok: true,
        data: { nodes: [], edges: [], branches: [], truncated: false },
      };
    if (operation === "job.queue") {
      reads.push({ operation, input });
      return {
        ok: true,
        data: {
          total: 3,
          jobs: [],
          leases: [],
          counts: [
            { lane: "apple_device", reason: "waiting_device", count: 3 },
          ],
        },
      };
    }
    if (operation === "job.activity")
      return {
        ok: true,
        data: {
          measuredAt: new Date(measuredAt).toISOString(),
          windows: { paceMinutes: 5, completedMinutes: 15, failedMinutes: 60 },
          streams: quiet
            ? []
            : [
                "image.device",
                "embedding.refresh",
                "derived.drain",
                "jobs.retention",
                "image.device.wake",
              ].map((kind) => ({
                kind,
                feature: null,
                running: failuresOnly ? 0 : 1,
                due: failuresOnly ? 0 : 3,
                backingOff: 0,
                scheduled: 0,
                paused: 0,
                completedPerMinute: failuresOnly ? 0 : 2,
                completed: failuresOnly ? 0 : 4,
                failed: failuresOnly ? 3 : 0,
                lastCompletedAt: null,
                oldestDueAt: null,
                runIds: ["RUN-4K7MN", "RUN-5K7MN", "RUN-6K7MN", "RUN-7K7MN"],
              })),
        },
      };
    if (operation === "job.health")
      return {
        ok: true,
        data: {
          snapshot: {
            // The watchdog measures every five minutes, independently of reads.
            measuredAt: new Date(Date.now() - 120_000).toISOString(),
            kinds: [],
            imageDisagreement: 0,
            alerts:
              quiet || failuresOnly
                ? []
                : [
                    {
                      kind: "image.device",
                      code: "expired_leases",
                      evidence: "Synthetic expired leases",
                    },
                    {
                      kind: "derived.drain",
                      code: "no_claims",
                      evidence: "Synthetic derived watchdog",
                    },
                  ],
          },
        },
      };
    if (operation === "job.deviceBacklog")
      return {
        ok: true,
        data: {
          waiting: 3,
          runsWaiting: 1,
          workingDevices: 0,
          claimsPerMinute: 0,
          etaSeconds: null,
        },
      };
    if (operation === "job.explain")
      return {
        ok: true,
        data: {
          steps: [
            {
              ref: code,
              kind: "job",
              label: "Synthetic Job chain",
              state: "queued",
              waitingOn: null,
              detail: "Synthetic retained diagnostic",
            },
          ],
          rollup: null,
        },
      };
    if (operation === "job.logs")
      return {
        ok: true,
        data: {
          status: "not_configured",
          dashboardUrl: "https://example.test/logs",
        },
      };
    if (operation === "job.retryNow") {
      retried.push(input);
      return { ok: true, data: { retried: 1 } };
    }
    throw new Error(`Unexpected operation ${operation}`);
  });
});
afterEach(() => {
  restore?.();
  harness.dispose();
});

function Overview() {
  const [search, setSearch] = useState<QueueSearch>({});
  return (
    <QueueOverview
      search={search}
      onSearchChange={(patch) =>
        setSearch((previous) => ({ ...previous, ...patch }))
      }
    />
  );
}

it("embeds bounded attention and Job tables, scopes chips, and expands the selected Job's diagnostics", async () => {
  render(<Overview />, { wrapper: harness.wrapper });
  const watchdog = await screen.findByTestId("queue-health");
  expect(
    within(watchdog).getByText(/Synthetic expired leases/),
  ).not.toBeVisible();
  const stream = (await screen.findAllByTestId("work-stream"))[0];
  if (!stream) throw new Error("Missing synthetic work stream");
  expect(stream).toHaveTextContent("Not moving");
  expect(stream).toHaveTextContent(
    "Work was not finished before its claim expired",
  );
  expect(within(stream).getAllByRole("link")).toHaveLength(3);
  expect(stream).toHaveTextContent("+1");
  expect(await screen.findByTestId("work-stream-derived")).toHaveTextContent(
    "Not moving",
  );
  expect(screen.queryByText("Net backlog since opened")).toBeNull();
  expect(screen.queryByText("Jobs retention")).toBeNull();
  expect(screen.queryByText("Image device wake")).toBeNull();
  expect(screen.getByText("Work is moving")).toBeInTheDocument();
  await userEvent.click(within(watchdog).getByText("Watchdog details"));
  expect(within(watchdog).getByText(/Synthetic expired leases/)).toBeVisible();
  expect(await screen.findByTestId("device-backlog")).toBeVisible();
  const jobs = await screen.findByRole("table", { name: "Jobs table" });
  expect(await within(jobs).findByText("image.device")).toBeVisible();
  const closedRow = within(jobs)
    .getAllByRole("row")
    .find((row) =>
      within(row).queryByRole("button", { name: `Explain ${code}` }),
    );
  if (!closedRow) throw new Error("Missing synthetic Job row");
  expect(Math.round(closedRow.getBoundingClientRect().height)).toBe(32);
  expect(screen.queryByText("Image work processing")).toBeNull();
  await waitFor(() =>
    expect(reads).toContainEqual(
      expect.objectContaining({
        entity: "run",
        pagination: { pageIndex: 0, pageSize: 10 },
        filters: expect.objectContaining({ needsAttention: true }),
        sort: [
          { orderBy: "stalled", direction: "desc" },
          { orderBy: "startedAt", direction: "desc" },
        ],
      }),
    ),
  );
  expect(reads).not.toContainEqual(
    expect.objectContaining({
      filters: expect.objectContaining({ kind: ["foreign"] }),
    }),
  );
  const all = await screen.findByRole("link", { name: "All 12" });
  expect(all.getAttribute("href")).toContain("/runs");
  expect(all.getAttribute("href")).toContain("needsAttention");
  await userEvent.click(
    await screen.findByRole("button", {
      name: /Apple devices · Waiting for any Apple device 3/,
    }),
  );
  await waitFor(() =>
    expect(reads).toContainEqual(
      expect.objectContaining({
        entity: "job",
        filters: expect.objectContaining({
          lane: ["apple_device"],
          reason: ["waiting_device"],
        }),
      }),
    ),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: `Explain ${code}` }),
  );
  expect(await screen.findByText("Synthetic Job chain")).toBeVisible();
  expect(
    await screen.findByText("Inline logs aren't configured"),
  ).toBeVisible();
  await userEvent.click(
    within(screen.getByTestId("job-explain")).getByRole("button", {
      name: "Retry now",
    }),
  );
  await waitFor(() =>
    expect(retried).toContainEqual({ filter: { codes: [code] } }),
  );
});

it("retries the current filter without widening to other lanes", async () => {
  render(
    <QueueOverview
      search={{ lane: "apple_device", reason: "waiting_device" }}
      onSearchChange={() => {}}
    />,
    { wrapper: harness.wrapper },
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Retry matching Jobs now" }),
  );
  await waitFor(() =>
    expect(retried).toContainEqual({
      filter: {
        entityFilters: expect.objectContaining({
          lane: ["apple_device"],
          reason: ["waiting_device"],
        }),
      },
    }),
  );
});

it("retries selected Job codes through the same visible filter", async () => {
  render(
    <QueueOverview
      search={{ lane: "apple_device" }}
      onSearchChange={() => {}}
    />,
    { wrapper: harness.wrapper },
  );
  const jobs = await screen.findByRole("table", { name: "Jobs table" });
  await userEvent.click(
    await within(jobs).findByRole("checkbox", { name: "Select row" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Retry 1 selected Job now" }),
  );
  await waitFor(() =>
    expect(retried).toContainEqual({
      filter: {
        codes: [code],
        entityFilters: expect.objectContaining({ lane: ["apple_device"] }),
      },
    }),
  );
});

it("opens an Activity Job inspector at desktop width", async () => {
  render(<Overview />, { wrapper: harness.wrapper });
  const jobs = await screen.findByRole("table", { name: "Jobs table" });
  await userEvent.click(await within(jobs).findByText("image.device"));
  const dialog = await screen.findByRole("dialog", {
    name: `Job ${code} preview`,
  });
  await waitFor(() => expect(dialog).toBeVisible());
  expect(
    await within(dialog).findByText("Synthetic retained diagnostic"),
  ).toBeVisible();
});

it("requests navigable chip counts from the Job table population", async () => {
  render(<Overview />, { wrapper: harness.wrapper });
  await waitFor(() =>
    expect(reads).toContainEqual(
      expect.objectContaining({
        operation: "job.queue",
        input: expect.objectContaining({
          filter: { entityFilters: {} },
          pageSize: 1,
        }),
      }),
    ),
  );
});

it("keeps phone commands below readable stream identity and facts", async () => {
  await page.viewport(390, 1100);
  render(<Overview />, { wrapper: harness.wrapper });
  const row = (await screen.findAllByTestId("work-stream"))[0];
  if (!row) throw new Error("Missing synthetic work stream");
  const label = within(row).getByText("Photo processing on Apple devices");
  const jobs = within(row).getByRole("button", { name: "Jobs" });
  expect(label.getBoundingClientRect().width).toBeGreaterThan(150);
  expect(jobs.getBoundingClientRect().top).toBeGreaterThan(
    label.getBoundingClientRect().bottom,
  );
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(390);
});

it("reads All quiet without a live indicator when no work is outstanding", async () => {
  quiet = true;
  render(<Overview />, { wrapper: harness.wrapper });
  expect(await screen.findByText(/All quiet · 0 finished/)).toBeVisible();
  expect(screen.queryByText("Work is moving")).toBeNull();
  expect(screen.queryByTestId("work-stream")).toBeNull();
});

it("keeps failed-only streams destructive and their Jobs actions available", async () => {
  failuresOnly = true;
  render(<Overview />, { wrapper: harness.wrapper });
  const row = (await screen.findAllByTestId("work-stream"))[0];
  if (!row) throw new Error("Missing failed stream");
  expect(within(row).getByLabelText("Failed")).toHaveClass("text-destructive");
  expect(row).toHaveTextContent("3 failed in 60 min");
  await userEvent.click(within(row).getByRole("button", { name: "Jobs" }));
  await waitFor(() =>
    expect(reads).toContainEqual(
      expect.objectContaining({
        entity: "job",
        filters: expect.objectContaining({ kind: ["image.device"] }),
      }),
    ),
  );
});

it("shows derived read errors and Retry even without an aged backlog, never All quiet", async () => {
  quiet = true;
  backlogFails = true;
  render(<Overview />, { wrapper: harness.wrapper });
  const section = await screen.findByRole("heading", {
    name: "Derived values",
  });
  expect(section).toBeVisible();
  expect(
    (await screen.findAllByText("Couldn't load derived values.")).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText(/All quiet/)).toBeNull();
  backlogFails = false;
  const retry = screen.getAllByRole("button", { name: /Retry/ })[0];
  if (!retry) throw new Error("Missing derived Retry action");
  await userEvent.click(retry);
  expect(await screen.findByText(/All quiet · 0 finished/)).toBeVisible();
});

it("keeps the derived loading section visible while reads are paused offline", async () => {
  quiet = true;
  onlineManager.setOnline(false);
  try {
    render(<Overview />, { wrapper: harness.wrapper });
    expect(
      await screen.findByRole("heading", {
        name: "Derived values",
      }),
    ).toBeVisible();
    expect(screen.queryByText(/All quiet/)).toBeNull();
  } finally {
    onlineManager.setOnline(true);
  }
});

it("ages cached successful work while offline without a live glyph, pace or ETA", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(measuredAt);
  try {
    render(<Overview />, { wrapper: harness.wrapper });
    await screen.findByText("Work is moving");
    onlineManager.setOnline(false);
    await act(async () => {
      clock.mockReturnValue(measuredAt + 120_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.queryByText("Work is moving")).toBeNull();
    const rows = await screen.findAllByTestId("work-stream");
    expect(rows[0]?.textContent).toMatch(/Data.*2 min.*ago/);
    expect(rows[0]).not.toHaveTextContent("/min");
    expect(rows[0]).not.toHaveTextContent("left");
    expect(screen.queryByText(/All quiet/)).toBeNull();
  } finally {
    clock.mockRestore();
    onlineManager.setOnline(true);
  }
});
