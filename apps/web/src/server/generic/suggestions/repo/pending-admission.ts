import { sql } from "drizzle-orm";

export type SuggestionRecordSelection = {
  entity?: string;
  records?: readonly { code: string; entity: string; id: string }[];
};

export const recommendationScopes = {
  connection: sql`s.subject->>'scope' LIKE 'connection.%'`,
};
