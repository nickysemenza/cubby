import type { DerivedSidecar } from "@cubby/schemas/derived-value";
import type {
  ListGroupSummary,
  ListGroupMembership,
} from "@cubby/schemas/pagination";

import type { ListReadRow } from "~/entity/model/list-read-fields";

/** Repository batch bindings retain their local preparation names. They are never deferred reads. */
export type ListBindingGroup = "media" | "quality" | "relations" | "derived";

export type { ListProjection } from "~/entity/model/list-read-fields";

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count: number;
  derived?: Record<string, DerivedSidecar>;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
  memberships?: ListGroupMembership[];
  membershipCount?: number;
}
