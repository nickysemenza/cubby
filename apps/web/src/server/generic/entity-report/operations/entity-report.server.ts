import { entityReportContract } from "~/contracts/entity-report.contract";
import {
  buildEntityReport,
  buildEntityReports,
} from "~/server/generic/entity-report/repo";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

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
