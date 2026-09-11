import {
  entityIntegrityContract,
  integrityProblemsContract,
} from "~/contracts/entity-integrity.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const REFERENTIAL_LIVENESS_INPUT = {
  key: "referentialLivenessViolations",
} as const;

export const entityIntegrity = defineOperationDomain(entityIntegrityContract, {
  catalog: {
    tags: [["entityIntegrity"]],
  },
});

export const integrityProblems = defineOperationDomain(
  integrityProblemsContract,
  {
    getByType: {
      tags: [["problems"]],
    },
  },
);
