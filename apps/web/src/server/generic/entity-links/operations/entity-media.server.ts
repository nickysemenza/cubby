import { entityMediaContract } from "~/contracts/entity-media.contract";
import { getEntityDisplayImages } from "~/server/generic/entity-links/repo/entity-media";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const entityMediaHandlers = implementOperationDomain(
  entityMediaContract,
  {
    displayImages: (context, input) =>
      getEntityDisplayImages(context.db, input.refs),
  },
);
