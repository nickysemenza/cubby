import { createFileRoute } from "@tanstack/react-router";

import { HouseholdContributionLedger } from "~/app/finance/household-contribution-ledger";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/household-contribution")({
  component: HouseholdContributionPage,
  head: () => ({ meta: [{ title: pageTitle("Household Contribution") }] }),
});

function HouseholdContributionPage() {
  return (
    <Page
      variant="list"
      title="Household contribution"
      eyebrow="Finance ledger"
      layout="full"
    >
      <HouseholdContributionLedger />
    </Page>
  );
}
