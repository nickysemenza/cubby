import {
  type householdContributionLedgerInput,
  householdContributionLedgerOut,
  type projectContributionInput,
  projectContributionOut,
} from "@cubby/schemas/household-contribution";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as contributionBrowser from "~/server/household-contribution-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const ledgerTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) =>
      input as z.input<typeof householdContributionLedgerInput>,
  )
  .handler(({ data, context }) =>
    contributionBrowser.householdContributionLedgerForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const projectTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof projectContributionInput>,
  )
  .handler(({ data, context }) =>
    contributionBrowser.projectContributionForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const ledgerOperation = startOperation<
  z.input<typeof householdContributionLedgerInput>,
  z.output<typeof householdContributionLedgerOut>
>({
  operation: "householdContribution.ledger",
  transport: (data, { signal, headers }) =>
    ledgerTransport({ data, signal, headers }),
  parse: (value) => householdContributionLedgerOut.parse(value),
});

const projectOperation = startOperation<
  z.input<typeof projectContributionInput>,
  z.output<typeof projectContributionOut>
>({
  operation: "householdContribution.project",
  transport: (data, { signal, headers }) =>
    projectTransport({ data, signal, headers }),
  parse: (value) => projectContributionOut.parse(value),
});

export const householdContributionLedgerQueryOptions = (
  input: z.input<typeof householdContributionLedgerInput>,
) =>
  queryOptions({
    queryKey: ["householdContribution", "ledger", { input }] as const,
    meta: ledgerOperation.meta,
    queryFn: ({ signal }) => ledgerOperation.call(input, { signal }),
  });

export const projectContributionQueryOptions = (
  input: z.input<typeof projectContributionInput>,
) =>
  queryOptions({
    queryKey: ["householdContribution", "project", { input }] as const,
    meta: projectOperation.meta,
    queryFn: ({ signal }) => projectOperation.call(input, { signal }),
  });
