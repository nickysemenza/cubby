import { parseShortcode } from "@cubby/shared";

/** Scope related financial suggestions by their declared filters. */
export function recordSuggestionScope(id: string) {
  const entity = parseShortcode(id)?.type;
  if (entity === "financialAccount") return { account: [id] };
  if (entity === "vendor") return { vendor: [id] };
  return { recordIds: [id] };
}
