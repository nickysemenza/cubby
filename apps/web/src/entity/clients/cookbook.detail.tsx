import {
  CookbookActions,
  CookbookContents,
  CookbookImportProgress,
} from "~/app/cookbooks/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const cookbookDetailHooks = defineDetailHooks("cookbook", {
  slots: {
    toc: { component: CookbookContents },
    "import-progress": { component: CookbookImportProgress },
  },
  headerActions: CookbookActions,
});
