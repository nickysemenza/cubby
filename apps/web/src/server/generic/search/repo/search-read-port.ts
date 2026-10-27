import type { SearchableEntity } from "@cubby/schemas/search";
import type { SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";

export type SearchableEntityText = {
  entityKind: SearchableEntity;
  entityId: string;
  embeddingText: string;
};

export type EmbeddingLoadOptions = { ids?: string[]; limit?: number };

type SearchDocumentContext = {
  types: SQL;
  requested: (column: SQL) => SQL;
  bounded: (column: SQL) => SQL;
  entityIds?: readonly string[];
  page?: {
    cursor?: { entityKind: SearchableEntity; entityId: string };
    pageSize?: number;
    createdBefore?: string;
  };
};

export type SearchReadPort = {
  document: (context: SearchDocumentContext) => SQL;
  prefix?: (context: SearchDocumentContext) => SQL;
  embedding: (
    db: Database | DrizzleTransaction,
    options?: EmbeddingLoadOptions,
  ) => Promise<SearchableEntityText[]>;
};
