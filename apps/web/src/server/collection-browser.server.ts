import { collection } from "~/app/collections/collection.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getSmartCollectionDetail,
  listSmartCollections,
} from "~/server/repo/collection";
import {
  createCollection,
  listCollectionSummaries,
  readCollectionDetail,
  readCollectionMatrix,
  setCollectionMembership,
} from "~/server/workflows/collection";

export const collectionHandlers = implementOperationDomain(collection, {
  smartList: (context, input) =>
    listSmartCollections(context.db, input.definitions),
  smartDetail: (context, input) =>
    getSmartCollectionDetail(
      context.db,
      input.definition,
      input.search,
      input.pagination,
    ),
  list: listCollectionSummaries,
  detail: readCollectionDetail,
  matrix: readCollectionMatrix,
  set: setCollectionMembership,
  create: createCollection,
});
