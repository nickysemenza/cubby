import {
  partyContributionSummary,
  partyHoldingsSummary,
} from "~/server/domains/ledger-party/repo/report-summary";
import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "ledgerParty.contribution-summary": reportBuilder(partyContributionSummary),
  "ledgerParty.owned-holdings": reportBuilder(partyHoldingsSummary),
};
