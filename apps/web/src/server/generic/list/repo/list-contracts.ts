import type { ListGroupSummary } from "@cubby/schemas/pagination";

import type {
  ListEnrichmentGroup,
  ListReadRow,
} from "~/entity/model/list-read-fields";

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count: number;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
}

export interface ListProjection {
  kind: "full" | "base" | "enrichment";
  groups?: readonly ListEnrichmentGroup[];
}
