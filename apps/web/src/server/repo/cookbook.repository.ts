import { defineRepository, listOn, onDb } from "~/server/repo/repository";

import {
  COOKBOOK_DELETE_EDGE_POLICY,
  cookbookList,
  getCookbookSummary,
} from "./cookbook";

/**
 * Declared `lifecycle: "readOnly"`: a cookbook is born from an EPUB import
 * and deleted with its recipes by that workflow (`deleteCookbook`, under the
 * policy declared here); the kernel serves reads only.
 */
export const cookbookRepository = defineRepository("cookbook", {
  lifecycle: { delete: COOKBOOK_DELETE_EDGE_POLICY },
  get: onDb(getCookbookSummary),
  list: listOn(cookbookList),
});
