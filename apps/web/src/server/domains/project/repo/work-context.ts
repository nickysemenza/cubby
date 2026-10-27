import type { Database } from "~/server/db";
import { computeAttentionItems } from "~/server/domains/project/repo/attention";
import { loadProjectSubtreeRollups } from "~/server/domains/project/repo/subtree";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { WorkScope } from "~/server/generic/work-queue/repo/work-source";

/** One composition belongs to one read, including diagnostics and Project rows. */
export const projectWorkContext = () => {
  let loaded: ReturnType<typeof loadProjectSubtreeRollups> | undefined;
  let attention: ReturnType<typeof computeAttentionItems> | undefined;
  const load = (db: Database) => (loaded ??= loadProjectSubtreeRollups(db));
  const attentionItems = (db: Database, scope: WorkScope) =>
    (attention ??= (async () => {
      const ids =
        scope.record?.entity === "project"
          ? [
              ...(
                await resolveLiveShortcodes(db, [scope.record.id], "project")
              ).values(),
            ]
          : undefined;
      return computeAttentionItems(db, {
        projectIds: ids,
        preloaded: load(db),
      });
    })());
  return { load, attentionItems };
};
export type ProjectWorkContext = ReturnType<typeof projectWorkContext>;
