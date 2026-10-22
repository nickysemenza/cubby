import type {
  ListGroupSummary,
  ListGroupMembership,
} from "@cubby/schemas/pagination";

import type { ListReadRow } from "~/entity/model/list-read-fields";

export type { ListProjection } from "~/entity/model/list-read-fields";

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count: number;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
  memberships?: ListGroupMembership[];
  membershipCount?: number;
}
