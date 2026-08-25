import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  householdContributionLedgerInput,
  householdContributionLedgerOut,
  householdContributionLedgerWorkflow,
  projectContributionInput,
  projectContributionOut,
  projectContributionWorkflow,
} from "~/server/workflows/household-contribution.server";

export const householdContributionLedgerForBrowser = (options: {
  data: z.input<typeof householdContributionLedgerInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "householdContribution.ledger",
    type: "query",
    input: options.data,
    inputSchema: householdContributionLedgerInput,
    outputSchema: householdContributionLedgerOut,
    request: options.request,
    run: (context, input) =>
      householdContributionLedgerWorkflow(context.readDb, input),
  });

export const projectContributionForBrowser = (options: {
  data: z.input<typeof projectContributionInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "householdContribution.project",
    type: "query",
    input: options.data,
    inputSchema: projectContributionInput,
    outputSchema: projectContributionOut,
    request: options.request,
    run: (context, input) => projectContributionWorkflow(context.readDb, input),
  });
