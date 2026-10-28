import { problemsStreamsContract } from "~/contracts/problems.contract";

import { defineOperationDomain } from "../operation-catalog";

export const problemsStreams = /* @__PURE__ */ defineOperationDomain(
  problemsStreamsContract,
);
