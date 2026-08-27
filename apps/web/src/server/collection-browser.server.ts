import { collection } from "~/app/collections/collection.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  createCollection,
  listCollectionSummaries,
  readCollectionDetail,
  readCollectionMatrix,
  setCollectionMembership,
} from "~/server/workflows/collection";

export const collectionHandlers = implementOperationDomain(collection, {
  list: { readPolicy: "strong", run: listCollectionSummaries },
  detail: { readPolicy: "strong", run: readCollectionDetail },
  matrix: { readPolicy: "strong", run: readCollectionMatrix },
  set: setCollectionMembership,
  create: createCollection,
});
