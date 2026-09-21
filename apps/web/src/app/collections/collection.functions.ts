import type { collectionMatrixOut } from "@cubby/schemas/collection";
import type { z } from "zod";

import { collectionContract } from "~/contracts/collection.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const collection = defineOperationDomain(collectionContract, {
  referenceDetail: {
    cache: "live-status",
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
  },
  smartList: {
    cache: "live-status",
    tags: [
      ["collection", "smartList"],
      ["product"],
      ["location"],
      ["inventory"],
      ["expense"],
      ["purchase"],
    ],
  },
  smartDetail: {
    cache: "live-status",
    tags: [
      ["collection", "smartDetail"],
      ["product"],
      ["location"],
      ["inventory"],
      ["expense"],
      ["purchase"],
    ],
  },
  list: { tags: [["collection", "list"]] },
  detail: { tags: [["collection", "detail"]] },
  matrix: { tags: [["collection", "matrix"]] },
  set: { invalidates: ripple.collection },
  create: { invalidates: ripple.collection },
});

export type CollectionMatrixRow = z.output<
  typeof collectionMatrixOut
>["rows"][number];
