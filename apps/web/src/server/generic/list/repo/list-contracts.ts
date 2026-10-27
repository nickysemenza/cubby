import type {
  ListGroupSummary,
  ListGroupMembership,
} from "@cubby/schemas/pagination";

import type { ListReadRow } from "~/entity/model/list-read-fields";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";

export type { ListProjection } from "~/entity/model/list-read-fields";

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count: number;
  unresolvedCount?: number;
  incompleteSums?: string[];
  fieldReads?: PageFieldReadContexts;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
  memberships?: ListGroupMembership[];
  membershipCount?: number;
}
