import { entityMediaContract } from "~/contracts/entity-media.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getEntityDisplayImages } from "~/server/repo/entity-media";

export const entityMediaHandlers = implementOperationDomain(
  entityMediaContract,
  {
    displayImages: (context, input) =>
      getEntityDisplayImages(context.readDb, input.refs),
  },
);
