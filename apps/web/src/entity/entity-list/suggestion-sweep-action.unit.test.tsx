import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { SuggestionSweepAction } from "./suggestion-sweep-action";

describe("suggestion sweep list action", () => {
  it("starts with the entity, every suggest target, and current filters", async () => {
    const start = vi.fn();
    const operations = {
      ...ai,
      startSuggestionSweep: ai.startSuggestionSweep.withTransport(
        async ({ input }) => {
          start(input);
          return { id: "22222222-2222-4222-8222-222222222222" };
        },
      ),
      pauseSuggestionSweep: ai.pauseSuggestionSweep.withTransport(async () => ({
        paused: true as const,
      })),
      resumeSuggestionSweep: ai.resumeSuggestionSweep.withTransport(
        async () => ({ id: "22222222-2222-4222-8222-222222222222" }),
      ),
      latestSuggestionSweepStatus: ai.latestSuggestionSweepStatus.withTransport(
        async () => ({
          latestRunId: null,
          entity: null,
          fields: [],
          taxonomyChanged: false,
          status: null,
          paused: false,
          progress: null,
        }),
      ),
    };
    const fields = entityFieldModels.expense.fields.flatMap((field) =>
      field.control?.suggest ? [field.key] : [],
    );
    const harness = createBrowserTestHarness();
    render(
      <SuggestionSweepAction
        entity="expense"
        filters={{ costType: "materials", searchQuery: "Synthetic" }}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggest for these rows" }),
    );
    await waitFor(() =>
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        entity: "expense",
        fields,
        filters: { costType: "materials", searchQuery: "Synthetic" },
      }),
    );
    harness.dispose();
  });

  it("refreshes list queries when a running sweep completes", async () => {
    let statusReads = 0;
    const operations = {
      ...ai,
      startSuggestionSweep: ai.startSuggestionSweep.withTransport(async () => ({
        id: "22222222-2222-4222-8222-222222222222",
      })),
      pauseSuggestionSweep: ai.pauseSuggestionSweep.withTransport(async () => ({
        paused: true as const,
      })),
      resumeSuggestionSweep: ai.resumeSuggestionSweep.withTransport(
        async () => ({
          id: "22222222-2222-4222-8222-222222222222",
        }),
      ),
      latestSuggestionSweepStatus: ai.latestSuggestionSweepStatus.withTransport(
        async () => {
          statusReads++;
          const completed = statusReads >= 3;
          return {
            latestRunId: "22222222-2222-4222-8222-222222222222",
            entity: "expense",
            fields: ["projectId"],
            taxonomyChanged: false,
            status: completed ? ("completed" as const) : ("running" as const),
            paused: false,
            progress: {
              total: 1,
              done: completed ? 1 : 0,
              applied: 0,
              queued: 0,
              failed: 0,
            },
          };
        },
      ),
    };
    const listQueryKey = ["synthetic-expense-list"] as const;
    const harness = createBrowserTestHarness();
    await harness.queryClient.fetchQuery({
      queryKey: listQueryKey,
      queryFn: async () => [],
      meta: { cacheTags: [["expense"]] },
    });
    render(
      <SuggestionSweepAction
        entity="expense"
        filters={{}}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggest for these rows" }),
    );
    await waitFor(() => expect(statusReads).toBeGreaterThanOrEqual(2));
    await harness.queryClient.fetchQuery({
      queryKey: listQueryKey,
      queryFn: async () => [],
      meta: { cacheTags: [["expense"]] },
    });
    await waitFor(
      () =>
        expect(
          harness.queryClient.getQueryState(listQueryKey)?.isInvalidated,
        ).toBe(true),
      { timeout: 4000 },
    );
    expect(statusReads).toBeGreaterThanOrEqual(3);
    harness.dispose();
  });
});
