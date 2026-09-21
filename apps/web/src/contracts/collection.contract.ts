import {
  smartCollectionReferenceInput,
  collectionCreateInput,
  collectionDetailInput,
  collectionDetailOut,
  collectionMatrixInput,
  collectionMatrixOut,
  collectionSummaryOut,
  collectionTagSetInput,
  collectionTagSetOut,
  smartCollectionListInput,
  smartCollectionSummary,
  smartCollectionDetailInput,
  smartCollectionDetailOut,
} from "@cubby/schemas/collection";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const collectionContract = defineContract("collection", {
  referenceDetail: query({
    native: "Collection by reference",
    input: smartCollectionReferenceInput,
    output: smartCollectionDetailOut,
  }),
  smartList: query({
    input: smartCollectionListInput,
    output: z.array(smartCollectionSummary),
  }),
  smartDetail: query({
    input: smartCollectionDetailInput,
    output: smartCollectionDetailOut,
  }),
  list: query({
    input: z.null(),
    output: z.array(collectionSummaryOut),
  }),
  detail: query({
    input: collectionDetailInput,
    output: collectionDetailOut,
  }),
  matrix: query({
    input: collectionMatrixInput,
    output: collectionMatrixOut,
  }),
  set: mutation({
    input: collectionTagSetInput,
    output: collectionTagSetOut,
  }),
  create: mutation({
    input: collectionCreateInput,
    output: collectionSummaryOut,
  }),
});
