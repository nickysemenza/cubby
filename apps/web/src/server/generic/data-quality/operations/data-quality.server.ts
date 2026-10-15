import { dataQualityContract } from "~/contracts/data-quality.contract";
import {
  clearDataException,
  setDataException,
} from "~/server/generic/data-quality/repo/exceptions";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const dataQualityHandlers = implementOperationDomain(
  dataQualityContract,
  {
    setException: (context, input) =>
      setDataException(context.db, input, context.actorContext),
    clearException: (context, input) =>
      clearDataException(context.db, input, context.actorContext),
  },
);
