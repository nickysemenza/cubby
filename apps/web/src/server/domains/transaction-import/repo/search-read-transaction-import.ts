import { transactionImport } from "~/server/db/schema";
import { storedSearchRead } from "~/server/generic/search/repo/search-read-port";

/** Import search presents the retained source and file fingerprint. */
export const transactionImportSearch = storedSearchRead({
  entity: "transactionImport",
  table: transactionImport,
  title: transactionImport.label,
  subtitle: transactionImport.fingerprint,
  typeHint: transactionImport.source,
  keywords: [transactionImport.notes],
});
