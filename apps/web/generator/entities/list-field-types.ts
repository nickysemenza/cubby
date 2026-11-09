import type { EntityDeclarationMetadata } from "@cubby/schemas/entity-definitions/definition";
import type {
  GeneratedListField,
  GeneratedRowSet,
  GeneratedGroupChoice,
  GeneratedInherit,
  GeneratedListScope,
  GeneratedListFieldPresentation,
} from "@cubby/schemas/entity-projection-types";

export type CompiledEntityListFields = Readonly<{
  /** One semantic vocabulary for column, group, sort and filter renderers. */
  presentation: Readonly<
    Record<string, GeneratedListFieldPresentation<string>>
  >;
  derived: Readonly<Record<string, GeneratedListField<string>>>;
  /** `model.rows`, the row sets a `via` may start at. */
  rows: Readonly<Record<string, GeneratedRowSet<string>>>;
  /** Text filter key → its declared `listTermExpanders` entry. */
  terms: Readonly<Record<string, string>>;
  /** Field key → its compiled `resolution.inherit`. */
  inherit: Readonly<Record<string, GeneratedInherit<string>>>;
  hierarchy: Readonly<{
    parentField: string;
    column: string;
    maxDepth: number;
  }> | null;
  /** Filter key → its generated "Include sub-…" toggle's filter key. */
  subtree: Readonly<Record<string, { key: string; default: boolean }>>;
  /** `model.grouping`, in menu order. */
  grouping: readonly GeneratedGroupChoice<string>[];
  metrics: readonly { key: string; label: string; format: string | null }[];
  evidenceMetrics: EntityDeclarationMetadata["presentation"]["list"]["evidenceMetrics"];
  /** `presentation.list.scope`: columns pinned to NULL on every list read. */
  scope: readonly string[];
  /** `presentation.list.scopes`, by request key. */
  scopes: Readonly<Record<string, GeneratedListScope<string>>>;
}>;
