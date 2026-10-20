import { assessmentFamily } from "@cubby/schemas/assessment";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { Page } from "~/entity/page/page";
import { AutomaticDecisions } from "~/entity/suggestions/queue/automatic-decisions";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/automatic-decisions")({
  validateSearch: z.object({
    record: z.string().optional(),
    family: assessmentFamily.optional(),
  }),
  component: AutomaticDecisionsPage,
  head: () => ({ meta: [{ title: pageTitle("Review automatic decisions") }] }),
});
function AutomaticDecisionsPage() {
  const { record, family } = Route.useSearch();
  return (
    <Page variant="list" title="Review automatic decisions" layout="full">
      <AutomaticDecisions
        key={`${record}:${family}`}
        id={record}
        initialFamily={family}
      />
    </Page>
  );
}
