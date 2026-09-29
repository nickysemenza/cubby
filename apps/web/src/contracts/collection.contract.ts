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
    cache: {
      tags: [
        ["product"],
        ["inventory"],
        ["location"],
        ["expense"],
        ["purchase"],
        ["financialAccount"],
        ["vendorAccount"],
        ["ledgerParty"],
      ],
      profile: "live-status",
    },
  }),
  smartList: query({
    input: smartCollectionListInput,
    output: z.array(smartCollectionSummary),
    cache: {
      tags: [
        ["collection", "smartList"],
        ["product"],
        ["location"],
        ["inventory"],
        ["expense"],
        ["purchase"],
      ],
      profile: "live-status",
    },
  }),
  smartDetail: query({
    input: smartCollectionDetailInput,
    output: smartCollectionDetailOut,
    cache: {
      tags: [
        ["collection", "smartDetail"],
        ["product"],
        ["location"],
        ["inventory"],
        ["expense"],
        ["purchase"],
      ],
      profile: "live-status",
    },
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
    invalidates: ["collection"],
  }),
  create: mutation({
    input: collectionCreateInput,
    output: collectionSummaryOut,
    invalidates: ["collection"],
  }),
});
