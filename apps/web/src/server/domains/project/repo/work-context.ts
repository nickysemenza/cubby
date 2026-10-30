import type { Database } from "~/server/db";
import {
  computeAttentionItems,
  projectAttentionFilterTypes,
} from "~/server/domains/project/repo/attention";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import type { WorkScope } from "~/server/generic/work-queue/repo/work-source";

/** One composition shares current attention checks across admitted Project reasons. */
export const projectWorkContext = () => {
  let attention: ReturnType<typeof computeAttentionItems> | undefined;
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
        types: Object.values(projectAttentionFilterTypes),
      });
    })());
  const incompleteProjectIds = async () =>
    attention ? (await attention).incompleteProjectIds : [];
  return { attentionItems, incompleteProjectIds };
};
export type ProjectWorkContext = ReturnType<typeof projectWorkContext>;
