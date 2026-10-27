import type { ScoredEntity } from "@cubby/schemas/data-quality";

import { STORED_QUALITY_ENTRIES } from "~/server/generated/data-quality-entries.gen";
import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";
import type { StoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

export const storedEntryFor = (
  entity: ScoredEntity,
): StoredEntityChecks<ScoredEntity, ScoredTable> =>
  STORED_QUALITY_ENTRIES[entity];
