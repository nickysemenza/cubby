// Pure decision for which of an ingredient's aliases are "unused" — kept free of
// any `~/` imports so the vitest `unit` project can test it directly. An alias is
// unused when it is REDUNDANT (case-insensitively equal to the ingredient's own
// name, or a case-insensitive duplicate of an earlier alias) OR NOT MATCHED by
// any recipe line (no live recipe line, re-parsed, yields a name that both equals
// the alias and resolves to this ingredient).

interface ComputeUnusedAliasesArgs {
  /** The ingredient's id. */
  id: string;
  /** The ingredient's canonical name. */
  name: string;
  /** The ingredient's full current alias list, in order. */
  aliases: string[];
  /**
   * For each lowercased parsed recipe-line name, the set of ingredient ids it
   * resolved to (built by re-parsing every live recipe line).
   */
  resolvedNameToIngredientIds: Map<string, Set<string>>;
}

/**
 * Returns the subset of `aliases` that are unused (redundant OR not matched by
 * recipes). For a case-insensitive duplicate the FIRST occurrence is kept and
 * later ones are flagged. Preserves the original casing of each flagged alias so
 * the caller can strip them by value.
 */
export function computeUnusedAliases(args: ComputeUnusedAliasesArgs): string[] {
  const { id, name, aliases, resolvedNameToIngredientIds } = args;
  const nameLower = name.toLowerCase();
  const seen = new Set<string>();
  const unused: string[] = [];

  for (const alias of aliases) {
    const lower = alias.toLowerCase();
    const redundant = lower === nameLower || seen.has(lower);
    const matched = resolvedNameToIngredientIds.get(lower)?.has(id) ?? false;
    if (redundant || !matched) unused.push(alias);
    seen.add(lower);
  }

  return unused;
}
