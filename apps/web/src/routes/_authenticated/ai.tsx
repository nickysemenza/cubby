import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { Page } from "~/entity/page/page";
import { AiUsagePage } from "~/features/ai/ai-usage-page";
import { DecisionsCatalog } from "~/features/ai/decisions-catalog";
import { suggestionReviewFiltersSchema } from "~/features/ai/suggestion-review-filters";
import { SuggestionReviewList } from "~/features/ai/suggestion-review-list";
import { AiSmokeTest } from "~/features/developer/ai-smoke-test";
import { pageTitle } from "~/lib/page-title";
import { useTabParam } from "~/ui/hooks/use-tab-param";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

const tabSchema = z.enum(["decisions", "review", "smoke", "usage"]);
const filters = suggestionReviewFiltersSchema.shape;

/** Every Review filter lives in the URL so Work queue rows, Run detail and
 * the Decisions catalog can link straight to a filtered list. */
const searchSchema = z.object({
  tab: tabSchema.optional().catch(undefined),
  decision: z.string().max(200).optional().catch(undefined),
  entity: filters.entity.catch(undefined),
  field: filters.field.catch(undefined),
  kind: filters.kind.catch(undefined),
  runId: filters.runId.catch(undefined),
  status: filters.status.catch(undefined),
  minConfidence: filters.minConfidence.catch(undefined),
});

export const Route = createFileRoute("/_authenticated/ai")({
  validateSearch: searchSchema,
  component: AiRoute,
  head: () => ({ meta: [{ title: pageTitle("AI") }] }),
});

function AiRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const tabs = useTabParam(search.tab, "decisions", tabSchema, (next) =>
    navigate({ to: ".", search: (previous) => ({ ...previous, tab: next }) }),
  );
  return (
    <Page variant="list" title="AI" compact>
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList
          variant="line"
          className="h-auto max-w-full flex-wrap justify-start gap-2 [&>[data-slot=tabs-trigger]]:flex-none"
        >
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="smoke">Smoke tests</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
        <TabsContent value="decisions">
          {tabs.value === "decisions" ? (
            <DecisionsCatalog
              selected={search.decision}
              onSelect={(decision) =>
                void navigate({
                  to: ".",
                  search: (previous) => ({ ...previous, decision }),
                })
              }
            />
          ) : null}
        </TabsContent>
        <TabsContent value="review">
          {tabs.value === "review" ? (
            <SuggestionReviewList
              filters={search}
              onFiltersChange={(patch) =>
                void navigate({
                  to: ".",
                  replace: true,
                  search: (previous) => ({ ...previous, ...patch }),
                })
              }
            />
          ) : null}
        </TabsContent>
        <TabsContent value="smoke">
          {tabs.value === "smoke" ? <AiSmokeTest /> : null}
        </TabsContent>
        <TabsContent value="usage">
          {tabs.value === "usage" ? <AiUsagePage /> : null}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
