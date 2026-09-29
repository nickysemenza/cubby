import { dataQualityContract } from "~/contracts/data-quality.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  clearDataException,
  setDataException,
} from "~/server/repo/data-quality";

export const dataQualityHandlers = implementOperationDomain(
  dataQualityContract,
  {
    setException: (context, input) =>
      setDataException(context.db, input, context.actorContext),
    clearException: (context, input) =>
      clearDataException(context.db, input, context.actorContext),
  },
);
