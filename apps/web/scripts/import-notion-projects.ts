/**
 * One-time (idempotent) import of the Notion project tracker — the projects /
 * Tasks / Purchases databases — into the Project / Task / Purchase tables.
 * Run locally against Neon:
 *
 *   cd apps/web && npx tsx scripts/import-notion-projects.ts [--dry-run] [--skip-images]
 *
 * Design notes:
 * - Upserts key on `notionPageId`, so re-runs update in place. Dependency edges
 *   are rebuilt (delete + insert) each run.
 * - Deliberately self-contained (own Notion client, own R2 PUT, direct drizzle
 *   writes) rather than importing app server modules: those pull in `~/env`
 *   validation and the `~` path alias, which don't resolve under plain tsx.
 * - Notion-hosted image URLs are signed and expire in ~5 minutes, so images are
 *   downloaded in the same pass that discovers them.
 * - Everything fetched is also archived as raw JSON (+ image files) OUTSIDE the
 *   repo (default ~/cubby-notion-archive/<date>) — the belt-and-suspenders
 *   backup to keep before the Notion databases are deleted.
 * - Reconciliation report at the end; oddities are reported, never fatal.
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ProjectId,
  type TaskId,
  unsafeProjectId,
} from "@cubby/schemas/identifiers";
import {
  type ProjectKind,
  type ProjectStatus,
  type PurchaseCategory,
  type Purchaser,
  projectKindValues,
  projectStatusValues,
  purchaseCategoryValues,
  purchaserValues,
  type TaskStatus,
  taskStatusValues,
} from "@cubby/schemas/project";
import { Client } from "@notionhq/client";
import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints/blocks";
import type {
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints/common";
import { AwsClient } from "aws4fetch";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  image,
  project,
  projectDependency,
  projectImage,
  purchase,
  task,
  taskDependency,
} from "../src/server/db/schema";

// ---------------------------------------------------------------------------
// Config / wiring
// ---------------------------------------------------------------------------

const DATA_SOURCE_IDS = {
  projects: "359f9bad-4815-4a9a-8de9-c6072e8fb5f2",
  tasks: "7c203038-5c1a-411a-8019-5698643c0394",
  purchases: "85bb653f-15a5-44d7-8389-93c93202219a",
} as const;

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_IMAGES = process.argv.includes("--skip-images");
const ARCHIVE_DIR =
  process.env.NOTION_ARCHIVE_DIR ??
  join(
    homedir(),
    "cubby-notion-archive",
    new Date().toISOString().slice(0, 10),
  );

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const notion = new Client({ auth: requireEnv("NOTION_API_KEY") });
const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
const db = drizzle(pool);

const R2_PUBLIC_URL = requireEnv("R2_PUBLIC_URL");
const R2_KEY_PREFIX = process.env.R2_KEY_PREFIX ?? "cubby-dev";
const r2 = new AwsClient({
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  service: "s3",
  region: "auto",
});
const r2ObjectUrl = (key: string) =>
  `${requireEnv("R2_ENDPOINT")}/${requireEnv("R2_BUCKET_NAME")}/${key}`;

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

// Reconciliation report accumulators.
const oddities: string[] = [];
const failures: string[] = [];

// ---------------------------------------------------------------------------
// Small mappers
// ---------------------------------------------------------------------------

/** Notion page ids appear dashed and undashed; canonicalize to dashed. */
const normalizeUuid = (id: string): string => {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * "🪵 materials" → "materials"; "metal / weld" stays as-is. Emoji_Component
 * covers skin-tone modifiers, VS16, and ZWJ, so composed emoji strip fully.
 */
const stripEmoji = (value: string): string =>
  value
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Component}]+/gu, "")
    .trim();

const enumOrNull = <T extends string>(
  values: readonly T[],
  raw: string | null,
  context: string,
): T | null => {
  if (raw === null) return null;
  if ((values as readonly string[]).includes(raw)) return raw as T;
  oddities.push(`${context}: unmapped value ${JSON.stringify(raw)} → null`);
  return null;
};

const STATUS_MAP: Record<string, string> = {
  Planning: "planning",
  "Not started": "not_started",
  "In progress": "in_progress",
  Done: "done",
  Blocked: "blocked",
  later: "later",
};

const mapStatus = <T extends string>(
  values: readonly T[],
  raw: string | null,
  context: string,
  fallback: T,
): T => {
  const mapped = raw === null ? null : (STATUS_MAP[raw] ?? null);
  if (mapped !== null && (values as readonly string[]).includes(mapped)) {
    return mapped as T;
  }
  oddities.push(
    `${context}: unmapped status ${JSON.stringify(raw)} → ${fallback}`,
  );
  return fallback;
};

// -- Property extraction (PageObjectResponse) --

type Properties = PageObjectResponse["properties"];
type PropertyValue = Properties[string];

const getTitle = (prop: PropertyValue | undefined): string =>
  prop?.type === "title" ? prop.title.map((t) => t.plain_text).join("") : "";
const getStatus = (prop: PropertyValue | undefined): string | null =>
  prop?.type === "status" ? (prop.status?.name ?? null) : null;
const getSelect = (prop: PropertyValue | undefined): string | null =>
  prop?.type === "select" ? (prop.select?.name ?? null) : null;
const getMultiSelect = (prop: PropertyValue | undefined): string[] =>
  prop?.type === "multi_select" ? prop.multi_select.map((s) => s.name) : [];
const getNumber = (prop: PropertyValue | undefined): number | null =>
  prop?.type === "number" ? prop.number : null;
const getDateStart = (prop: PropertyValue | undefined): string | null =>
  prop?.type === "date" ? (prop.date?.start.slice(0, 10) ?? null) : null;
const getDateEnd = (prop: PropertyValue | undefined): string | null =>
  prop?.type === "date" ? (prop.date?.end?.slice(0, 10) ?? null) : null;
const getUrl = (prop: PropertyValue | undefined): string | null =>
  prop?.type === "url" ? prop.url : null;
const getCheckbox = (prop: PropertyValue | undefined): boolean =>
  prop?.type === "checkbox" ? prop.checkbox : false;
const getRichTextProp = (prop: PropertyValue | undefined): string | null => {
  if (prop?.type !== "rich_text") return null;
  const text = prop.rich_text
    .map((t) => t.plain_text)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
};
const getRelationIds = (prop: PropertyValue | undefined): string[] =>
  prop?.type === "relation"
    ? prop.relation.map((r) => normalizeUuid(r.id))
    : [];
const getPageIcon = (page: PageObjectResponse): string | null =>
  page.icon?.type === "emoji" ? page.icon.emoji : null;
const getPageCover = (page: PageObjectResponse): string | null =>
  page.cover?.type === "file"
    ? page.cover.file.url
    : page.cover?.type === "external"
      ? page.cover.external.url
      : null;

// ---------------------------------------------------------------------------
// Notion fetch
// ---------------------------------------------------------------------------

async function queryAllPages(
  dataSourceId: string,
): Promise<PageObjectResponse[]> {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      start_cursor: cursor,
    });
    pages.push(
      ...response.results.filter(
        (r): r is PageObjectResponse => "properties" in r,
      ),
    );
    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (cursor);
  return pages;
}

async function listChildren(blockId: string): Promise<BlockObjectResponse[]> {
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    blocks.push(
      ...response.results.filter((b): b is BlockObjectResponse => "type" in b),
    );
    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (cursor);
  return blocks;
}

// ---------------------------------------------------------------------------
// Images → R2
// ---------------------------------------------------------------------------

const uploadedImages: { key: string; projectName: string }[] = [];

async function downloadImage(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      failures.push(`image fetch ${response.status}: ${url.split("?")[0]}`);
      return null;
    }
    const contentType =
      response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      failures.push(
        `non-image content-type ${contentType}: ${url.split("?")[0]}`,
      );
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      failures.push(
        `image size ${buffer.length}b out of range: ${url.split("?")[0]}`,
      );
      return null;
    }
    return { buffer, contentType };
  } catch (error) {
    failures.push(`image fetch error: ${String(error)}`);
    return null;
  }
}

const contentTypeExtension: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
};

/**
 * Download a Notion-hosted image, archive it locally, upload it to R2, insert
 * an Image row, and return { imageId, publicUrl } — or null on any failure.
 */
async function importImage(
  sourceUrl: string,
  projectSlug: string,
  index: number,
): Promise<{ imageId: string; publicUrl: string } | null> {
  const downloaded = await downloadImage(sourceUrl);
  if (!downloaded) return null;
  const { buffer, contentType } = downloaded;

  // Notion S3 paths end .../<uuid>/<original-filename>; keep the filename.
  const pathName = new URL(sourceUrl).pathname.split("/").pop() ?? "image.jpg";
  const safeName = decodeURIComponent(pathName).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const ext = contentTypeExtension[contentType] ?? "jpg";
  const filename = safeName.includes(".") ? safeName : `${safeName}.${ext}`;

  // Archive a local copy alongside the raw JSON.
  const archivePath = join(ARCHIVE_DIR, "images", projectSlug);
  await mkdir(archivePath, { recursive: true });
  await writeFile(join(archivePath, `${index}-${filename}`), buffer);

  if (DRY_RUN || SKIP_IMAGES) {
    return { imageId: "dry-run", publicUrl: `dry-run://${filename}` };
  }

  const key = `${R2_KEY_PREFIX}/images/project-${projectSlug}-${index}-${filename}`;
  const publicUrl = `${R2_PUBLIC_URL}/${key}`;
  const put = await r2.fetch(r2ObjectUrl(key), {
    method: "PUT",
    body: new Uint8Array(buffer),
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  if (!put.ok) {
    failures.push(`R2 PUT ${put.status} for ${key}`);
    return null;
  }

  const [row] = await db
    .insert(image)
    .values({
      key,
      url: publicUrl,
      filename,
      size: buffer.length,
      contentType,
      status: "UPLOADED",
    })
    .onConflictDoNothing()
    .returning({ id: image.id });
  if (!row) {
    // Key already exists from a prior run — look it up.
    const existing = await db
      .select({ id: image.id })
      .from(image)
      .where(eq(image.key, key));
    if (!existing[0]) {
      failures.push(`image row missing after conflict for ${key}`);
      return null;
    }
    uploadedImages.push({ key, projectName: projectSlug });
    return { imageId: existing[0].id, publicUrl };
  }
  uploadedImages.push({ key, projectName: projectSlug });
  return { imageId: row.id, publicUrl };
}

// ---------------------------------------------------------------------------
// Blocks → markdown
// ---------------------------------------------------------------------------

function richTextToMarkdown(items: RichTextItemResponse[]): string {
  return items
    .map((item) => {
      let text = item.plain_text;
      if (item.annotations.code) text = `\`${text}\``;
      if (item.annotations.bold) text = `**${text}**`;
      if (item.annotations.italic) text = `*${text}*`;
      if (item.annotations.strikethrough) text = `~~${text}~~`;
      if (item.href && item.plain_text.trim().length > 0) {
        text = `[${text}](${item.href})`;
      }
      return text;
    })
    .join("");
}

type MarkdownContext = {
  projectSlug: string;
  imageCounter: { value: number };
  collectImage: (imageId: string) => void;
};

/** Render one block (and its children) to markdown lines. */
async function blockToMarkdown(
  block: BlockObjectResponse,
  ctx: MarkdownContext,
  depth: number,
): Promise<string[]> {
  const indent = "  ".repeat(depth);
  const childLines = async (parent: BlockObjectResponse, nextDepth: number) =>
    parent.has_children
      ? (
          await Promise.all(
            (
              await listChildren(parent.id)
            ).map((child) => blockToMarkdown(child, ctx, nextDepth)),
          )
        ).flat()
      : [];

  switch (block.type) {
    case "paragraph": {
      const text = richTextToMarkdown(block.paragraph.rich_text);
      return text.trim() ? [`${indent}${text}`, ""] : [];
    }
    case "heading_1":
      return [`# ${richTextToMarkdown(block.heading_1.rich_text)}`, ""];
    case "heading_2":
      return [`## ${richTextToMarkdown(block.heading_2.rich_text)}`, ""];
    case "heading_3":
      return [`### ${richTextToMarkdown(block.heading_3.rich_text)}`, ""];
    case "bulleted_list_item":
      return [
        `${indent}- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}`,
        ...(await childLines(block, depth + 1)),
      ];
    case "numbered_list_item":
      return [
        `${indent}1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}`,
        ...(await childLines(block, depth + 1)),
      ];
    case "to_do":
      return [
        `${indent}- [${block.to_do.checked ? "x" : " "}] ${richTextToMarkdown(block.to_do.rich_text)}`,
        ...(await childLines(block, depth + 1)),
      ];
    case "quote":
      return [`> ${richTextToMarkdown(block.quote.rich_text)}`, ""];
    case "callout":
      return [`> ${richTextToMarkdown(block.callout.rich_text)}`, ""];
    case "code": {
      const lang =
        block.code.language === "plain text" ? "" : block.code.language;
      return [
        `\`\`\`${lang}`,
        richTextToMarkdown(block.code.rich_text),
        "```",
        "",
      ];
    }
    case "divider":
      return ["---", ""];
    case "bookmark":
      return [`<${block.bookmark.url}>`, ""];
    case "embed":
      return [`<${block.embed.url}>`, ""];
    case "link_preview":
      return [`<${block.link_preview.url}>`, ""];
    case "toggle":
      return [
        `${indent}- ${richTextToMarkdown(block.toggle.rich_text)}`,
        ...(await childLines(block, depth + 1)),
      ];
    case "image": {
      const url =
        block.image.type === "file"
          ? block.image.file.url
          : block.image.type === "external"
            ? block.image.external.url
            : null;
      if (!url) return [];
      const index = ctx.imageCounter.value++;
      const imported = await importImage(url, ctx.projectSlug, index);
      if (!imported) return [];
      ctx.collectImage(imported.imageId);
      return [`![](${imported.publicUrl})`, ""];
    }
    case "table": {
      const rows = await listChildren(block.id);
      const lines: string[] = [];
      rows.forEach((row, i) => {
        if (row.type !== "table_row") return;
        const cells = row.table_row.cells.map((cell) =>
          richTextToMarkdown(cell).replace(/\|/g, "\\|"),
        );
        lines.push(`| ${cells.join(" | ")} |`);
        if (i === 0) {
          lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
      });
      lines.push("");
      return lines;
    }
    case "column_list": {
      // Flatten columns sequentially.
      const columns = await listChildren(block.id);
      const lines: string[] = [];
      for (const column of columns) {
        lines.push(...(await childLines(column, depth)));
      }
      return lines;
    }
    case "child_page":
      // Sub-pages stay in Notion (out of scope) — leave a breadcrumb.
      return [`*(Notion subpage: ${block.child_page.title})*`, ""];
    case "child_database":
      return [`*(Notion sub-database: ${block.child_database.title})*`, ""];
    default:
      return [];
  }
}

/** Convert a project page body to markdown; returns null for empty bodies. */
async function pageBodyToMarkdown(
  pageId: string,
  ctx: MarkdownContext,
): Promise<string | null> {
  const blocks = await listChildren(pageId);
  const lines = (
    await Promise.all(blocks.map((block) => blockToMarkdown(block, ctx, 0)))
  ).flat();
  const markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown.length > 0 ? markdown : null;
}

// ---------------------------------------------------------------------------
// Import passes
// ---------------------------------------------------------------------------

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "untitled";

async function main() {
  console.log(
    `Importing Notion project tracker${DRY_RUN ? " (DRY RUN)" : ""} — archive: ${ARCHIVE_DIR}`,
  );
  await mkdir(ARCHIVE_DIR, { recursive: true });

  // -- Fetch everything from Notion first --
  const [projectPages, taskPages, purchasePages] = await Promise.all([
    queryAllPages(DATA_SOURCE_IDS.projects),
    queryAllPages(DATA_SOURCE_IDS.tasks),
    queryAllPages(DATA_SOURCE_IDS.purchases),
  ]);
  console.log(
    `Fetched ${projectPages.length} projects, ${taskPages.length} tasks, ${purchasePages.length} purchases`,
  );
  await writeFile(
    join(ARCHIVE_DIR, "projects.json"),
    JSON.stringify(projectPages, null, 2),
  );
  await writeFile(
    join(ARCHIVE_DIR, "tasks.json"),
    JSON.stringify(taskPages, null, 2),
  );
  await writeFile(
    join(ARCHIVE_DIR, "purchases.json"),
    JSON.stringify(purchasePages, null, 2),
  );

  // -- Pass 1: projects (bodies + images inline; Notion URLs expire fast) --
  const projectIdByNotionId = new Map<string, ProjectId>();
  const archivedBodies: Record<string, unknown> = {};

  for (const page of projectPages) {
    const p = page.properties;
    const notionPageId = normalizeUuid(page.id);
    const name = getTitle(p.Name) || "(untitled)";
    const slug = slugify(name);

    const existing = await db
      .select({ id: project.id })
      .from(project)
      .where(
        sql`${project.notionPageId} = ${notionPageId} AND ${project.deletedAt} IS NULL`,
      );
    const existingId = existing[0]?.id;

    // Body → markdown (+ images). Skip image/body work when the project was
    // already imported WITH images — re-downloading would duplicate R2 objects.
    const alreadyHasImages = existingId
      ? (
          await db
            .select({ id: projectImage.id })
            .from(projectImage)
            .where(eq(projectImage.projectId, existingId))
        ).length > 0
      : false;

    const collectedImageIds: string[] = [];
    const ctx: MarkdownContext = {
      projectSlug: slug,
      imageCounter: { value: 0 },
      collectImage: (id) => collectedImageIds.push(id),
    };

    let notes: string | null = null;
    try {
      notes = await pageBodyToMarkdown(page.id, ctx);
    } catch (error) {
      failures.push(`body conversion failed for ${name}: ${String(error)}`);
    }
    archivedBodies[notionPageId] = { name, notes };

    // Cover image (appended after body images).
    const coverUrl = getPageCover(page);
    if (coverUrl && !alreadyHasImages) {
      const imported = await importImage(
        coverUrl,
        slug,
        ctx.imageCounter.value++,
      );
      if (imported) collectedImageIds.push(imported.imageId);
    }

    const values = {
      name,
      status: mapStatus(
        projectStatusValues,
        getStatus(p.Status),
        `project ${name}`,
        "planning" as ProjectStatus,
      ),
      kind: enumOrNull<ProjectKind>(
        projectKindValues,
        getSelect(p.kind),
        `project ${name} kind`,
      ),
      locations: getMultiSelect(p.location),
      costEstimate: getNumber(p["cost estimate"]),
      startDate: getDateStart(p.Date),
      endDate: getDateEnd(p.Date),
      icon: getPageIcon(page),
      notes,
      notionPageId,
    };

    if (DRY_RUN) {
      // Placeholder mapping so relation resolution can still be exercised.
      projectIdByNotionId.set(
        notionPageId,
        existingId ?? unsafeProjectId(page.id),
      );
      continue;
    }

    let id: ProjectId;
    if (existingId) {
      await db.update(project).set(values).where(eq(project.id, existingId));
      id = existingId;
    } else {
      const inserted = await db
        .insert(project)
        .values({ ...values, createdAt: new Date(page.created_time) })
        .returning({ id: project.id });
      id = inserted[0]!.id;
    }
    projectIdByNotionId.set(notionPageId, id);

    // Attach newly-imported images (skipped entirely when already present).
    if (!alreadyHasImages && collectedImageIds.length > 0) {
      await db
        .insert(projectImage)
        .values(
          collectedImageIds.map((imageId, sortOrder) => ({
            projectId: id,
            imageId,
            sortOrder,
          })),
        )
        .onConflictDoNothing();
    }
  }
  await writeFile(
    join(ARCHIVE_DIR, "project-bodies.json"),
    JSON.stringify(archivedBodies, null, 2),
  );
  console.log(`Projects upserted: ${projectIdByNotionId.size}`);

  // -- Pass 2: tasks --
  const taskIdByNotionId = new Map<string, TaskId>();
  for (const page of taskPages) {
    const p = page.properties;
    const notionPageId = normalizeUuid(page.id);
    const name = getTitle(p.Name) || "(untitled)";
    const projectNotionIds = getRelationIds(p.project);
    const projectRef = projectNotionIds[0]
      ? (projectIdByNotionId.get(projectNotionIds[0]) ?? null)
      : null;
    if (projectNotionIds[0] && !projectRef) {
      oddities.push(`task ${name}: project relation not found`);
    }

    const values = {
      name,
      status: mapStatus(
        taskStatusValues,
        getStatus(p.Status),
        `task ${name}`,
        "not_started" as TaskStatus,
      ),
      projectId: DRY_RUN ? null : projectRef,
      dueDate: getDateStart(p.Due),
      dueEndDate: getDateEnd(p.Due),
      category: getSelect(p.category),
      notionPageId,
    };

    if (DRY_RUN) continue;

    const existing = await db
      .select({ id: task.id })
      .from(task)
      .where(
        sql`${task.notionPageId} = ${notionPageId} AND ${task.deletedAt} IS NULL`,
      );
    if (existing[0]) {
      await db.update(task).set(values).where(eq(task.id, existing[0].id));
      taskIdByNotionId.set(notionPageId, existing[0].id);
    } else {
      const inserted = await db
        .insert(task)
        .values({ ...values, createdAt: new Date(page.created_time) })
        .returning({ id: task.id });
      taskIdByNotionId.set(notionPageId, inserted[0]!.id);
    }
  }
  console.log(`Tasks upserted: ${taskIdByNotionId.size}`);

  // -- Pass 3: purchases --
  let purchaseCount = 0;
  for (const page of purchasePages) {
    const p = page.properties;
    const notionPageId = normalizeUuid(page.id);
    const name = getTitle(p.Name) || "(untitled)";
    const projectNotionIds = getRelationIds(p.Project);
    const projectRef = projectNotionIds[0]
      ? (projectIdByNotionId.get(projectNotionIds[0]) ?? null)
      : null;
    if (projectNotionIds[0] && !projectRef) {
      oddities.push(`purchase ${name}: project relation not found`);
    }

    const rawCategory = getSelect(p.category);
    const rawSubcategory = getSelect(p.subcategory);
    const date = getDateStart(p.Date);
    if (date && date < "2000-01-01") {
      oddities.push(`purchase ${name}: suspicious date ${date}`);
    }

    const values = {
      name,
      cost: getNumber(p.cost),
      date,
      category: enumOrNull<PurchaseCategory>(
        purchaseCategoryValues,
        rawCategory === null ? null : stripEmoji(rawCategory),
        `purchase ${name} category`,
      ),
      subcategory: rawSubcategory === null ? null : stripEmoji(rawSubcategory),
      purchaser: enumOrNull<Purchaser>(
        purchaserValues,
        getSelect(p.purchaser),
        `purchase ${name} purchaser`,
      ),
      url: getUrl(p.URL),
      notes: getRichTextProp(p.notes),
      future: getCheckbox(p.future),
      projectId: DRY_RUN ? null : projectRef,
      notionPageId,
    };

    if (DRY_RUN) {
      purchaseCount++;
      continue;
    }

    const existing = await db
      .select({ id: purchase.id })
      .from(purchase)
      .where(
        sql`${purchase.notionPageId} = ${notionPageId} AND ${purchase.deletedAt} IS NULL`,
      );
    if (existing[0]) {
      await db
        .update(purchase)
        .set(values)
        .where(eq(purchase.id, existing[0].id));
    } else {
      await db
        .insert(purchase)
        .values({ ...values, createdAt: new Date(page.created_time) });
    }
    purchaseCount++;
  }
  console.log(`Purchases upserted: ${purchaseCount}`);

  // -- Pass 4: dependency edges (rebuild wholesale — idempotent) --
  if (!DRY_RUN) {
    const projectEdges: {
      projectId: ProjectId;
      blockedByProjectId: ProjectId;
    }[] = [];
    for (const page of projectPages) {
      const id = projectIdByNotionId.get(normalizeUuid(page.id));
      if (!id) continue;
      for (const blockedByNotionId of getRelationIds(
        page.properties["Blocked by"],
      )) {
        const blockedById = projectIdByNotionId.get(blockedByNotionId);
        if (blockedById) {
          projectEdges.push({ projectId: id, blockedByProjectId: blockedById });
        } else {
          oddities.push(
            `project ${getTitle(page.properties.Name)}: unresolved Blocked-by relation`,
          );
        }
      }
    }
    await db
      .delete(projectDependency)
      .where(
        inArray(projectDependency.projectId, [...projectIdByNotionId.values()]),
      );
    if (projectEdges.length > 0) {
      await db.insert(projectDependency).values(projectEdges);
    }
    console.log(`Project dependency edges: ${projectEdges.length}`);

    const taskEdges: { taskId: TaskId; blockedByTaskId: TaskId }[] = [];
    for (const page of taskPages) {
      const id = taskIdByNotionId.get(normalizeUuid(page.id));
      if (!id) continue;
      for (const blockedByNotionId of getRelationIds(
        page.properties["Blocked by"],
      )) {
        const blockedById = taskIdByNotionId.get(blockedByNotionId);
        if (blockedById) {
          taskEdges.push({ taskId: id, blockedByTaskId: blockedById });
        } else {
          oddities.push(
            `task ${getTitle(page.properties.Name)}: unresolved Blocked-by relation`,
          );
        }
      }
    }
    await db
      .delete(taskDependency)
      .where(inArray(taskDependency.taskId, [...taskIdByNotionId.values()]));
    if (taskEdges.length > 0) {
      await db.insert(taskDependency).values(taskEdges);
    }
    console.log(`Task dependency edges: ${taskEdges.length}`);
  }

  // -- Reconciliation report --
  console.log("\n=== Reconciliation ===");
  if (!DRY_RUN) {
    const counts = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM "Project" WHERE "deletedAt" IS NULL) AS projects,
        (SELECT COUNT(*) FROM "Task" WHERE "deletedAt" IS NULL) AS tasks,
        (SELECT COUNT(*) FROM "Purchase" WHERE "deletedAt" IS NULL) AS purchases,
        (SELECT ROUND(SUM(cost)::numeric, 2) FROM "Purchase" WHERE "deletedAt" IS NULL) AS total_cost,
        (SELECT COUNT(*) FROM "ProjectImage") AS project_images
    `);
    console.log("DB:", counts.rows[0]);
  }
  const notionCostTotal = purchasePages.reduce(
    (sum, page) => sum + (getNumber(page.properties.cost) ?? 0),
    0,
  );
  console.log(
    `Notion: ${projectPages.length} projects, ${taskPages.length} tasks, ${purchasePages.length} purchases, total cost ${notionCostTotal.toFixed(2)}`,
  );
  console.log(`Images uploaded to R2: ${uploadedImages.length}`);

  if (oddities.length > 0) {
    console.log(`\n--- Oddities (${oddities.length}) — review manually ---`);
    for (const line of oddities) console.log(`  • ${line}`);
  }
  if (failures.length > 0) {
    console.log(`\n--- Failures (${failures.length}) ---`);
    for (const line of failures) console.log(`  • ${line}`);
  }
  console.log(
    failures.length > 0
      ? "\nDone WITH FAILURES — safe to re-run after fixing."
      : "\nDone.",
  );
}

try {
  await main();
} finally {
  await pool.end();
}
