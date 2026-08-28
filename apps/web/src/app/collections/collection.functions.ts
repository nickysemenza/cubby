import {
  collectionCreateInput,
  collectionDetailInput,
  collectionDetailOut,
  collectionMatrixInput,
  collectionMatrixOut,
  collectionSummaryOut,
  collectionTagSetInput,
  collectionTagSetOut,
} from "@cubby/schemas/collection";
import { z } from "zod";

import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const collection = defineOperationDomain("collection", {
  list: query({
    input: z.null(),
    output: z.array(collectionSummaryOut),
    tags: [["collection", "list"]],
  }),
  detail: query({
    input: collectionDetailInput,
    output: collectionDetailOut,
    tags: [["collection", "detail"]],
  }),
  matrix: query({
    input: collectionMatrixInput,
    output: collectionMatrixOut,
    tags: [["collection", "matrix"]],
  }),
  set: mutation({
    input: collectionTagSetInput,
    output: collectionTagSetOut,
    invalidates: [["collection"]],
  }),
  create: mutation({
    input: collectionCreateInput,
    output: collectionSummaryOut,
    invalidates: [["collection"]],
  }),
});

export type CollectionMatrixRow = z.output<
  typeof collectionMatrixOut
>["rows"][number];
