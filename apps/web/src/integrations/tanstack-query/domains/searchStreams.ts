import { searchStreamsContract } from "~/contracts/search.contract";

import { defineOperationDomain } from "../operation-catalog";

export const searchStreams = /* @__PURE__ */ defineOperationDomain(
  searchStreamsContract,
);
