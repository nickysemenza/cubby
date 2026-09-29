/**
 * A project's Notion page and Google Drive folder, stored as
 * `EntityExternalId` rows and exposed as the `notionPageUrl` /
 * `googleDriveFolderUrl` fields.
 *
 * The page row's `externalId` is the Notion page id (a Notion import wrote it
 * before any URL existed); clearing the URL keeps that identity and only
 * drops the link. A folder row is its folder id, parsed from the URL.
 */

import { GOOGLE_DRIVE_SOURCE, NOTION_SOURCE } from "@cubby/schemas/external-id";
import type { ProjectId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityExternalId } from "~/server/db/schema";
import {
  liveExternalIds,
  setSingleExternalId,
  singleExternalIds,
} from "~/server/repo/entity-external-ids";

const NOTION_PAGE = { source: NOTION_SOURCE, kind: "page" } as const;
const DRIVE_FOLDER = { source: GOOGLE_DRIVE_SOURCE, kind: "folder" } as const;

type ProjectExternalUrls = {
  googleDriveFolderUrl: string | null;
  notionPageUrl: string | null;
};

/** Each project row, with its Notion and Drive URLs attached. */
export async function withProjectExternalUrls<R extends { id: ProjectId }>(
  db: Database | DrizzleTransaction,
  rows: readonly R[],
): Promise<(R & ProjectExternalUrls)[]> {
  const ids = rows.map((row) => row.id);
  const [pages, folders] = await Promise.all([
    singleExternalIds(db, ids, NOTION_PAGE),
    singleExternalIds(db, ids, DRIVE_FOLDER),
  ]);
  return rows.map((row) => ({
    ...row,
    notionPageUrl: pages.get(row.id)?.url ?? null,
    googleDriveFolderUrl: folders.get(row.id)?.url ?? null,
  }));
}

/**
 * The Notion page id a page URL names: the trailing 32 hex digits of its last
 * path segment, dashed like the ids Notion's API returns. Null for a URL that
 * carries no page id (a custom notion.site path).
 */
const notionPageIdFromUrl = (url: string): string | null => {
  const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  const hex = segment?.replaceAll("-", "").slice(-32).toLowerCase();
  if (!hex || !/^[0-9a-f]{32}$/u.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const driveFolderIdFromUrl = (url: string): string | null =>
  /\/folders\/([A-Za-z0-9_-]+)/u.exec(new URL(url).pathname)?.[1] ?? null;

/**
 * Apply `notionPageUrl` / `googleDriveFolderUrl` writes; `undefined` leaves a
 * field alone. Inputs are already validated provider URLs.
 */
export async function setProjectExternalUrls(
  tx: DrizzleTransaction,
  projectId: ProjectId,
  urls: Partial<ProjectExternalUrls>,
): Promise<void> {
  const owner = { entityId: projectId, entityKind: "project" as const };
  if (urls.googleDriveFolderUrl !== undefined) {
    const url = urls.googleDriveFolderUrl;
    await setSingleExternalId(
      tx,
      owner,
      DRIVE_FOLDER,
      url === null
        ? null
        : { externalId: driveFolderIdFromUrl(url) ?? url, url },
    );
  }
  if (urls.notionPageUrl !== undefined) {
    const url = urls.notionPageUrl;
    if (url === null) {
      // Keep the page identity; only the link goes.
      await tx
        .update(entityExternalId)
        .set({ url: null })
        .where(
          and(
            liveExternalIds("page"),
            eq(entityExternalId.entityId, projectId),
            eq(entityExternalId.source, NOTION_SOURCE),
          ),
        );
      return;
    }
    await setSingleExternalId(tx, owner, NOTION_PAGE, {
      externalId: notionPageIdFromUrl(url) ?? url,
      url,
    });
  }
}
