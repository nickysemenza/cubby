import type {
  ListBatch,
  ListGroupMargin,
  ListGroupSummary,
  ListGroupMembership,
  ListGroupMetric,
} from "@cubby/schemas/pagination";

import type { ListReadRow } from "~/entity/model/list-read-fields";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";

export type { ListProjection } from "~/entity/model/list-read-fields";

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count?: number;
  hasNextPage: boolean;
  unresolvedCount?: number;
  incompleteSums?: string[];
  fieldReads?: PageFieldReadContexts;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
  margins?: ListGroupMargin[];
  memberships?: ListGroupMembership[];
  membershipCount?: number;
  metrics?: Record<string, ListGroupMetric>;
  batches?: ListBatch[];
}
