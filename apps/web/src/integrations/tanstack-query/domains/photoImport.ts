import { photoImportContract } from "~/contracts/photo-import.contract";

import { defineOperationDomain } from "../operation-catalog";

export const photoImport =
  /* @__PURE__ */ defineOperationDomain(photoImportContract);
