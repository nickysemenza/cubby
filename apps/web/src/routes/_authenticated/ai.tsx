import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { Page } from "~/entity/page/page";
import { AiUsagePage } from "~/features/ai/ai-usage-page";
import { DecisionsCatalog } from "~/features/ai/decisions-catalog";
import { pageTitle } from "~/lib/page-title";
import { useTabParam } from "~/ui/hooks/use-tab-param";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

const tabSchema = z.enum(["decisions", "usage"]);

const searchSchema = z.object({
  tab: tabSchema.optional().catch(undefined),
  decision: z.string().max(200).optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/ai")({
  validateSearch: searchSchema,
  component: AiRoute,
  head: () => ({ meta: [{ title: pageTitle("AI") }] }),
});

function AiRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/ai" });
  const tabs = useTabParam(search.tab, "decisions", tabSchema, (next) =>
    navigate({ to: ".", search: (previous) => ({ ...previous, tab: next }) }),
  );
  return (
    <Page variant="list" listChrome="workbench" title="AI">
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList
          variant="line"
          className="h-auto max-w-full flex-wrap justify-start gap-2 [&>[data-slot=tabs-trigger]]:flex-none"
        >
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
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
        <TabsContent value="usage">
          {tabs.value === "usage" ? <AiUsagePage /> : null}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
