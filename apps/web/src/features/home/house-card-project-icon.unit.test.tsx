import { entityReportOut } from "@cubby/schemas/entity-report";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog/entityReport.gen";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { TodayAttention } from "./house-card";

describe("home task project identity", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  let restoreDispatch: (() => void) | undefined;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    restoreDispatch?.();
    harness.dispose();
  });

  it("uses the briefing emoji without requesting the project roster", async () => {
    const taskId = testShortcode("task", "home-briefing-task");
    const projectId = testShortcode("project", "home-briefing-project");
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
                    id: taskId,
                    title: "Check the workbench",
                    trailing: null,
                    lines: [
                      {
                        text: "🔧 Workshop",
                        ref: { entity: "project", id: projectId },
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
    const requests: string[] = [];
    restoreDispatch = overrideStartDispatch(async (operation, input) => {
      if (operation === "entity.filterOptions") {
        requests.push(
          `${operation}:${z.object({ entity: z.string() }).parse(input).entity}`,
        );
        return { ok: true, data: { items: [], hasMore: false } };
      }
      requests.push(operation);
      if (operation === "entityMedia.displayImages")
        return { ok: true, data: {} };
      throw new Error(`Unexpected home request: ${operation}`);
    });

    render(<TodayAttention />, { wrapper: harness.wrapper });

    expect(
      await screen.findByRole("link", { name: /Workshop/ }),
    ).toHaveAttribute("href", `/projects/${projectId}`);
    expect(requests).not.toContain("entity.filterOptions:project");
  });
});
