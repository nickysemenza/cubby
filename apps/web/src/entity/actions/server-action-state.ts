import { entityActionStates } from "@cubby/schemas/action-availability";
import { z } from "zod";

const rowActions = z.object({ actions: entityActionStates });

/**
 * The server's availability for `verb` on a row (`entity.list` rows and
 * `entity.detail` carry it). Undefined for a row from a read that does not
 * carry it, such as a nested subject; callers treat that as not offered.
 */
export function serverActionState(row: unknown, verb: string) {
  const parsed = rowActions.safeParse(row);
  return parsed.success
    ? parsed.data.actions.find((action) => action.id === verb)
    : undefined;
}
