import type { SearchableEntity } from "@cubby/schemas/search";

const KEY = "cubby-recent-jumps";
const MAX_RECENTS = 6;

interface RecentJump {
  entityType: SearchableEntity;
  /**
   * The entity's PUBLIC id. Recents are a list of places to navigate to, and
   * navigation targets are shortcodes — storing the uuid would mean rebuilding
   * a uuid URL, which is exactly what the cutover removed.
   */
  shortcode: string;
  name: string;
}

/** Last few entities jumped to from the command menu (newest first). */
export function getRecents(): RecentJump[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // Entries written before the cutover carry a uuid `id` and no `shortcode`.
    // They can't be navigated to, so drop them rather than render dead rows.
    return (parsed as RecentJump[]).filter(
      (jump) => typeof jump?.shortcode === "string",
    );
  } catch {
    return [];
  }
}

export function pushRecent(jump: RecentJump): void {
  try {
    const next = [
      jump,
      ...getRecents().filter((r) => r.shortcode !== jump.shortcode),
    ].slice(0, MAX_RECENTS);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode etc. — recents just won't persist.
  }
}
