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
    mcp: { omit: "client_view" },
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
    mcp: { omit: "client_view" },
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
    mcp: { omit: "client_view" },
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
    mcp: { omit: "client_view" },
    input: z.null(),
    output: z.array(collectionSummaryOut),
  }),
  detail: query({
    mcp: { omit: "client_view" },
    input: collectionDetailInput,
    output: collectionDetailOut,
  }),
  matrix: query({
    mcp: { omit: "client_view" },
    input: collectionMatrixInput,
    output: collectionMatrixOut,
  }),
  set: mutation({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
      note: "`collection:*` tags are managed by Collections, so entity.update must not write them",
    },
    input: collectionTagSetInput,
    output: collectionTagSetOut,
    invalidates: ["collection"],
  }),
  create: mutation({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    input: collectionCreateInput,
    output: collectionSummaryOut,
    invalidates: ["collection"],
  }),
});
