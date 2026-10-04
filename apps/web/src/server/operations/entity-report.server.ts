import { entityReportContract } from "~/contracts/entity-report.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  buildEntityReport,
  buildEntityReports,
} from "~/server/repo/entity-report";

export const entityReportHandlers = implementOperationDomain(
  entityReportContract,
  {
    get: (context, input) =>
      buildEntityReport(
        context.db,
        input,
        () => context.currentParty(),
        context.actorContext,
        context.services,
      ),
    getMany: (context, input) =>
      buildEntityReports(
        context.db,
        input,
        () => context.currentParty(),
        context.actorContext,
        context.services,
      ),
  },
);
