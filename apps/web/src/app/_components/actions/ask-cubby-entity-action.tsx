import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/**
 * The question a record raises, carried to the place that answers it.
 *
 * Ask Cubby was reachable from exactly two places — the command palette and
 * `/ask` — and from neither of them did it know what you were looking at. So
 * the flow was: read a shortcode off a row, open the palette, retype it. This
 * registers asking as a verb like any other, which is what puts it in the row
 * menu, the selection bar and the palette at once.
 *
 * The question is seeded with the record's name and shortcode rather than a
 * templated sentence: the agent resolves shortcodes directly, and a canned
 * "Tell me about…" would be a worse prompt than whatever the person types
 * next into a box that is already focused on the right record.
 */
function useAskAboutEntityAction(): EntityActionHandles {
  const navigate = useNavigate();

  const ask = useCallback(
    (rows: readonly EntityActionRow[]) => {
      const row = rows[0];
      if (!row) return false;
      // Trimmed: a detail header hands over a name with its surrounding
      // whitespace, which reached the query as "Bathroom  (LOC-SD7J)".
      const name = row.name?.trim();
      const query = name ? `${name} (${row.id})` : row.id;
      navigate({ to: "/ask", search: { q: query } });
      return true;
    },
    [navigate],
  );

  return {
    run: async (rows) => ({ success: ask(rows) }),
    rowMenuItem: (row) => (
      <VerbMenuItem
        key="ask-about"
        verb="askAbout"
        onSelect={() => ask([row])}
      />
    ),
    dialog: null,
  };
}

export const askCubbyEntityActionDefinitions = [
  defineEntityAction({
    id: "ask-about",
    verb: "askAbout",
    entities: shortcodeEntities,
    // Single on purpose: "what about these fifty rows?" is not a question the
    // agent can answer usefully, and offering it would make the selection bar
    // promise something the prompt cannot carry.
    arity: "single",
    surfaces: ["row", "selection", "inspector", "detail", "palette-quick"],
    group: "primary",
    // After the copy verbs, before anything that changes a record: asking is
    // the cheapest, most reversible thing on the menu.
    priority: 10,
    placement: { inspector: "overflow", detail: "overflow" },
    preserveSelection: true,
    use: useAskAboutEntityAction,
  }),
] as const;
