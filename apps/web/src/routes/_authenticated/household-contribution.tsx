import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { HouseholdContributionLedger } from "~/features/finance/household-contribution-ledger";
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
