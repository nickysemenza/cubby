import { entityReportOut } from "@cubby/schemas/entity-report";
import { testShortcode } from "@cubby/schemas/testing";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { EntityAuditLink } from "~/entity/components/entity-ref-link";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityMedia } from "~/integrations/tanstack-query/domains/entityMedia";
import { entityReport } from "~/integrations/tanstack-query/domains/entityReport";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { TodayAttention } from "./house-card";

it("keeps activity identities on one desktop line, aligns codes, and stacks on phone", async () => {
  const harness = createBrowserTestHarness();
  try {
    for (const width of [1100, 280]) {
      await page.viewport(width === 1100 ? 1440 : 402, 900);
      render(
        <div style={{ width }} data-testid="frame">
          <EntityAuditLink
            entityKind="email"
            entityId="EML-4K7M"
            name="Delivery confirmed for two garden storage organizers"
            displayImage={null}
            layout="row"
          />
          <EntityAuditLink
            entityKind="email"
            entityId="EML-7M4K"
            name="Short confirmation"
            displayImage={null}
            layout="row"
          />
        </div>,
        { wrapper: harness.wrapper },
      );
      const links = screen.getAllByRole("link");
      const first = links[0];
      const second = links[1];
      if (!first || !second) throw new Error("Missing activity links");
      const pill = first.querySelector("[data-entity-pill]");
      if (!pill || !first.lastElementChild || !second.lastElementChild)
        throw new Error("Missing record identity");
      expect(first.getBoundingClientRect().right).toBeLessThanOrEqual(
        screen.getByTestId("frame").getBoundingClientRect().right,
      );
      expect(pill.getBoundingClientRect().height).toBeLessThan(
        width === 1100 ? 30 : 120,
      );
      expect(first.lastElementChild.getBoundingClientRect().x).toBe(
        width === 1100
          ? second.lastElementChild.getBoundingClientRect().x
          : pill.getBoundingClientRect().x,
      );
      expect(
        first.lastElementChild.getBoundingClientRect().top,
      ).toBeGreaterThanOrEqual(
        width === 1100
          ? pill.getBoundingClientRect().top
          : pill.getBoundingClientRect().bottom,
      );
      cleanup();
    }
  } finally {
    cleanup();
    harness.dispose();
  }
});

it("gives Today tasks and projects separate readable lines with bounded due dates", async () => {
  const harness = createBrowserTestHarness();
  harness.queryClient.setQueryData(
    cursorQueryOptions(entityReport.get, {
      slot: "task.briefing",
      scope: { kind: "list", entity: "task", filters: {} },
    }).queryKey,
    {
      pageParams: [null],
      pages: [
        entityReportOut.parse({
          blocks: [
            {
              kind: "records",
              empty: "No tasks",
              rows: [
                {
                  entity: "task",
                  id: testShortcode("task", "preview-garden-task"),
                  title:
                    "Check seasonal garden supplies and organize the seed cabinet",
                  trailing: "2026-10-10",
                  lines: [
                    {
                      text: "Garden planning for next season",
                      ref: {
                        entity: "project",
                        id: testShortcode("project", "preview-garden-project"),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    },
  );
  const restoreDispatch = overrideOperationDispatch(async (operation) => {
    if (operation === "entityMedia.displayImages")
      return { ok: true, data: {} };
    if (operation === "entityReport.get") {
      const cached = harness.queryClient.getQueryData(
        cursorQueryOptions(entityReport.get, {
          slot: "task.briefing",
          scope: { kind: "list", entity: "task", filters: {} },
        }).queryKey,
      );
      const pageData = entityReportOut.parse(
        cached &&
          typeof cached === "object" &&
          "pages" in cached &&
          Array.isArray(cached.pages)
          ? cached.pages[0]
          : {},
      );
      return { ok: true, data: pageData };
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });
  const queryOptions = entityMedia.displayImages.withTransport(
    async () => ({}),
  ).queryOptions;
  try {
    for (const width of [560, 350]) {
      await page.viewport(width === 560 ? 1440 : 402, 900);
      render(
        <div style={{ width }} data-testid="today-frame">
          <EntityDisplayImagesProvider
            refs={[]}
            collectMountedRefs
            queryOptions={queryOptions}
          >
            <TodayAttention />
          </EntityDisplayImagesProvider>
        </div>,
        { wrapper: harness.wrapper },
      );
      const task = await screen.findByRole("link", {
        name: /Check seasonal garden/,
      });
      const project = screen.getByRole("link", { name: /Garden planning/ });
      await waitFor(() =>
        expect(project.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          task.getBoundingClientRect().bottom,
        ),
      );
      expect(screen.getByTestId("today-frame").scrollWidth).toBeLessThanOrEqual(
        width,
      );
      cleanup();
    }
  } finally {
    restoreDispatch();
    cleanup();
    harness.dispose();
  }
});
