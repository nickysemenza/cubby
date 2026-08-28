import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

const KEY = "cubby-recent-jumps";
const MAX_RECENTS = 6;

interface RecentJump {
  entityType: z.infer<typeof searchableEntitySchema>;
  /** Canonical public id used as the navigation target. */
  id: string;
  name: string;
}

const storedRecentJumpSchema = z.object({
  entityType: searchableEntitySchema.optional(),
  id: z.string().optional(),
  shortcode: z.string().optional(),
  name: z.string().optional(),
});

/** Last few entities jumped to from the command menu (newest first). */
export function getRecents(): RecentJump[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): RecentJump[] => {
      const result = storedRecentJumpSchema.safeParse(value);
      if (!result.success) return [];
      const { entityType, name } = result.data;
      const id = result.data.id ?? result.data.shortcode;
      return entityType && id && name ? [{ entityType, id, name }] : [];
    });
  } catch {
    return [];
  }
}

export function pushRecent(jump: RecentJump): void {
  try {
    const next = [jump, ...getRecents().filter((r) => r.id !== jump.id)].slice(
      0,
      MAX_RECENTS,
    );
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode etc. — recents just won't persist.
  }
}
