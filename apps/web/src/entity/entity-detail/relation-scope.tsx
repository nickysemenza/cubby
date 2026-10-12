import type { Entity } from "@cubby/schemas/entity";
import { createContext, useContext } from "react";

/**
 * The record a relation section's rows are scoped to, so a row action can act
 * on the pair — an Email's Link/Dismiss on a Purchase page names that
 * Purchase. Null outside a relation section.
 */
export type RelationScope = { source: Entity; recordId: string };

export const RelationScopeContext = createContext<RelationScope | null>(null);

export const useRelationScope = () => useContext(RelationScopeContext);
