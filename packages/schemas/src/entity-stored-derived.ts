/** Every stored derived value declared in the entity manifest (ADR 0021). */
export { generatedStoredDerived as storedDerivedManifest } from "./generated/entity-stored-derived.gen";
import { generatedStoredResultSchemas } from "./generated/entity-stored-result-schemas.gen";
import type { StoredResultSchemas } from "./entity-metadata-types";
export const storedResultSchemas: StoredResultSchemas =
  generatedStoredResultSchemas;
