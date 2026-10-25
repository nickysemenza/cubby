import { shortcode } from "@cubby/schemas/identifiers";
import { jobOut } from "@cubby/schemas/job-entity";
import { runOut } from "@cubby/schemas/run";
import { render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { z } from "zod";

import { getEntityDetailOutputSchema } from "~/entity/generated/entity-details.gen";
import { installFeatures } from "~/features/registry";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { QueueOverview, type QueueSearch } from "./queue-overview";

installFeatures();
const code = shortcode("JOB-4K7MN4K7MN");
const run = mock(runOut, {
  overrides: {
    id: shortcode("RUN-4K7MN"),
    displayName: "Synthetic photo Run",
    purpose: "photo_inventory",
    status: "running",
    displayStatus: "running",
    stalled: true,
    waitingOn: "3 waiting for any Apple device",
  },
});
const work = mock(jobOut, {
  overrides: {
    id: code,
    kind: "image.device",
    lane: "apple_device",
    state: "queued",
    waitingOn: "Waiting for any Apple device",
    runId: run.id,
    runName: run.displayName,
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

beforeEach(async () => {
  await page.viewport(1440, 1200);
  reads.length = 0;
  retried.length = 0;
  // Foreign page filters/sort must never leak into either embedded list.
  harness = createBrowserTestHarness({
    initialPath: "/?kind=foreign&sort=-date",
  });
  restore = overrideStartDispatch(async (operation, input) => {
    if (operation === "entity.listBase") {
      reads.push(input);
      const { entity } = inputSchema.parse(input);
      return {
        ok: true,
        data: {
          entity,
          data: entity === "run" ? [run] : [work],
          meta: {
            pageIndex: 0,
            pageSize: entity === "run" ? 10 : 25,
            totalCount: entity === "run" ? 12 : 31,
          },
          groups:
            entity === "run"
              ? [
                  {
                    id: "derived",
                    fields: [
                      "stalled",
                      "waitingOn",
                      "displayStatus",
                      "chargedCost",
                    ],
                  },
                ]
              : [],
        },
      };
    }
    if (operation === "entity.listEnrichment") {
      const { entity } = inputSchema.parse(input);
      return {
        ok: true,
        data: {
          entity,
          missingIds: [],
          groups: [
            {
              id: "derived",
              fields: ["stalled", "waitingOn", "displayStatus", "chargedCost"],
              state: "ready",
              data: [run],
            },
          ],
        },
      };
    }
    if (operation === "entity.listSummary")
      return {
        ok: true,
        data: {
          entity: inputSchema.parse(input).entity,
          sums: {},
          totalLabels: {},
        },
      };
    if (operation === "entity.list")
      return {
        ok: true,
        data: {
          items: [],
          meta: { pageIndex: 0, pageSize: 50, totalCount: 0 },
        },
      };
    if (operation === "entity.detail")
      return {
        ok: true,
        data: mock(getEntityDetailOutputSchema("job"), {
          overrides: {
            ...work,
            displayImages: [],
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
    if (operation === "job.health")
      return {
        ok: true,
        data: {
          snapshot: {
            measuredAt: new Date().toISOString(),
            kinds: [],
            imageDisagreement: 0,
            alerts: [
              {
                kind: "image.device",
                code: "expired_leases",
                evidence: "Synthetic expired leases",
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
  expect(await screen.findByTestId("queue-health")).toHaveTextContent(
    "Synthetic expired leases",
  );
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
