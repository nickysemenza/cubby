import type { SearchableEntity } from "@cubby/schemas/search";

const KEY = "cubby-recent-jumps";
const MAX_RECENTS = 6;

interface RecentJump {
  entityType: SearchableEntity;
  /** Canonical public id used as the navigation target. */
  id: string;
  name: string;
}

/** Last few entities jumped to from the command menu (newest first). */
export function getRecents(): RecentJump[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): RecentJump[] => {
      if (!value || typeof value !== "object") return [];
      const legacy = value as Partial<RecentJump> & { shortcode?: unknown };
      const id =
        typeof legacy.id === "string"
          ? legacy.id
          : typeof legacy.shortcode === "string"
            ? legacy.shortcode
            : null;
      return id && legacy.entityType && typeof legacy.name === "string"
        ? [{ entityType: legacy.entityType, id, name: legacy.name }]
        : [];
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
