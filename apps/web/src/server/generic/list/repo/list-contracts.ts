import type { DerivedSidecar } from "@cubby/schemas/derived-value";
import type {
  ListGroupSummary,
  ListGroupMembership,
} from "@cubby/schemas/pagination";

import type { ListReadRow } from "~/entity/model/list-read-fields";

export type { ListProjection } from "~/entity/model/list-read-fields";

/**
 * Repository batch bindings, never deferred reads. Repository tracing must not
 * import the hydration implementation: its Worker Env consumers require
 * globals deliberately absent from repository programs.
 */
export type ListBindingGroup = "media" | "quality" | "relations" | "derived";

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count: number;
  derived?: Record<string, DerivedSidecar>;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
  memberships?: ListGroupMembership[];
  membershipCount?: number;
}
