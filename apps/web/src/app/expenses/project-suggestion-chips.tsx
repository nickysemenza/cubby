import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";

import {
  EntityRecommendations,
  type EntityRecommendationOperations,
} from "~/app/_components/relatedness/entity-recommendations";

interface ProjectSuggestionChipsProps {
  expense: ExpenseOut;
  onAssign: (projectId: ProjectShortcode) => Promise<void>;
  isPending: boolean;
  operations?: EntityRecommendationOperations;
}

/** Inline review for server-ranked project alternatives, including expenses
 * that already have a project. The existing project editor remains available. */
export function ProjectSuggestionChips({
  expense,
  onAssign,
  isPending,
  operations,
}: ProjectSuggestionChipsProps) {
  if (expense.date === null) return null;
  return (
    <EntityRecommendations
      source={{ entityType: "expense", entityId: expense.id }}
      operations={operations}
      compact
      pending={isPending}
      onAcceptExpenseProject={(proposal) => onAssign(proposal.target.id)}
    />
  );
}
