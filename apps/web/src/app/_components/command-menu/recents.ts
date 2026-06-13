import type { SearchableEntity } from "@cubby/schemas/search";

const KEY = "cubby-recent-jumps";
const MAX_RECENTS = 6;

interface RecentJump {
  entityType: SearchableEntity;
  id: string;
  name: string;
}

/** Last few entities jumped to from the command menu (newest first). */
export function getRecents(): RecentJump[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as RecentJump[]) : [];
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
