import { Client } from "@notionhq/client";
import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
} from "@notionhq/client/build/src/api-endpoints/blocks";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints/common";
import type { QueryDataSourceResponse } from "@notionhq/client/build/src/api-endpoints/data-sources";
import { LRUCache } from "lru-cache";
import pRetry from "p-retry";
import { z } from "zod";
import { getErrorMessage } from "~/lib/error-utils";
import { TraceNames, withTrace } from "~/server/tracing";

// Data source IDs from the Notion "Project Tracker" page (collection:// URLs)
const DATA_SOURCE_IDS = {
  projects: "359f9bad-4815-4a9a-8de9-c6072e8fb5f2",
  tasks: "7c203038-5c1a-411a-8019-5698643c0394",
  purchases: "85bb653f-15a5-44d7-8389-93c93202219a",
  // The "Recipes" database under Food → Recipes. Synced into Cubby recipes.
  recipes: "69f477cf-b5dd-4151-8508-8c8d1be19706",
} as const;

// -- Output types --
// Zod-sourced so the procedure `.output()` schemas (api/routers/notion.ts) and
// these types share one definition.

export const notionProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  kind: z.string().nullable(),
  location: z.array(z.string()),
  costEstimate: z.number().nullable(),
  date: z.string().nullable(),
  dateEnd: z.string().nullable(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  blockedBy: z.array(z.string()),
  blocking: z.array(z.string()),
  notionUrl: z.string(),
});
export type NotionProject = z.infer<typeof notionProjectSchema>;

export const notionTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  due: z.string().nullable(),
  category: z.string().nullable(),
  projectName: z.string().nullable(),
  notionUrl: z.string(),
});
export type NotionTask = z.infer<typeof notionTaskSchema>;

export const notionPurchaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  cost: z.number().nullable(),
  date: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  purchaser: z.string().nullable(),
  projectName: z.string().nullable(),
  url: z.string().nullable(),
  notionUrl: z.string(),
});
export type NotionPurchase = z.infer<typeof notionPurchaseSchema>;

// Output of the `notion.dashboard` query (null when Notion isn't configured).
export const notionDashboardSchema = z
  .object({
    projects: z.array(notionProjectSchema),
    tasks: z.array(notionTaskSchema),
    purchases: z.array(notionPurchaseSchema),
  })
  .nullable();

export type NotionBlock = {
  type: string;
  text?: string;
  checked?: boolean;
  imageUrl?: string;
  children?: NotionBlock[];
};

const notionBlockSchema: z.ZodType<NotionBlock> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    checked: z.boolean().optional(),
    imageUrl: z.string().optional(),
    children: z.array(notionBlockSchema).optional(),
  }),
);

export const notionProjectImagesOut = z.record(z.string(), z.string());

export const notionProjectContentInput = z.object({
  pageId: z.string(),
});

export const notionProjectContentOut = z.array(notionBlockSchema).nullable();

// One row of the Recipes database: the column metadata (the body comes from
// `getPageContent`). `yieldText`/`servings`/`tags` are read only if those
// optional columns exist on the data source.
const notionRecipeRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string().nullable(),
  yieldText: z.string().nullable(),
  servings: z.number().nullable(),
  tags: z.array(z.string()),
  notionUrl: z.string(),
});
export type NotionRecipeRow = z.infer<typeof notionRecipeRowSchema>;

// -- Property extraction helpers --

type Properties = PageObjectResponse["properties"];
type PropertyValue = Properties[string];

function getTitle(prop: PropertyValue | undefined): string {
  if (prop?.type === "title") {
    return prop.title.map((t) => t.plain_text).join("");
  }
  return "";
}

function getStatus(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "status") {
    return prop.status?.name ?? null;
  }
  return null;
}

function getSelect(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "select") {
    return prop.select?.name ?? null;
  }
  return null;
}

function getMultiSelect(prop: PropertyValue | undefined): string[] {
  if (prop?.type === "multi_select") {
    return prop.multi_select.map((s) => s.name);
  }
  return [];
}

function getNumber(prop: PropertyValue | undefined): number | null {
  if (prop?.type === "number") {
    return prop.number;
  }
  return null;
}

function getDateStart(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "date") {
    return prop.date?.start ?? null;
  }
  return null;
}

function getDateEnd(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "date") {
    return prop.date?.end ?? null;
  }
  return null;
}

function getUrl(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "url") {
    return prop.url;
  }
  return null;
}

function getRichText(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "rich_text") {
    const text = prop.rich_text
      .map((t) => t.plain_text)
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function getRelationIds(prop: PropertyValue | undefined): string[] {
  if (prop?.type === "relation") {
    return prop.relation.map((r) => r.id);
  }
  return [];
}

function getRelationId(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "relation" && prop.relation.length > 0) {
    return prop.relation[0]!.id;
  }
  return null;
}

function getPageUrl(page: PageObjectResponse): string {
  return page.url;
}

function getPageIcon(page: PageObjectResponse): string | null {
  if (page.icon?.type === "emoji") return page.icon.emoji;
  return null;
}

function getPageCover(page: PageObjectResponse): string | null {
  if (page.cover?.type === "file") return page.cover.file.url;
  if (page.cover?.type === "external") return page.cover.external.url;
  return null;
}

function extractPages(response: QueryDataSourceResponse): PageObjectResponse[] {
  return response.results.filter(
    (r): r is PageObjectResponse => "properties" in r,
  );
}

function getImageUrl(block: BlockObjectResponse): string | null {
  if (block.type !== "image") return null;
  const img = block.image;
  if (img.type === "file") return img.file.url;
  if (img.type === "external") return img.external.url;
  return null;
}

function getRichTextPlain(richText: Array<{ plain_text: string }>): string {
  return richText.map((t) => t.plain_text).join("");
}

function blockToNotionBlock(block: BlockObjectResponse): NotionBlock | null {
  switch (block.type) {
    case "paragraph":
      return {
        type: "paragraph",
        text: getRichTextPlain(block.paragraph.rich_text),
      };
    case "heading_1":
      return {
        type: "heading_1",
        text: getRichTextPlain(block.heading_1.rich_text),
      };
    case "heading_2":
      return {
        type: "heading_2",
        text: getRichTextPlain(block.heading_2.rich_text),
      };
    case "heading_3":
      return {
        type: "heading_3",
        text: getRichTextPlain(block.heading_3.rich_text),
      };
    case "bulleted_list_item":
      return {
        type: "bulleted_list_item",
        text: getRichTextPlain(block.bulleted_list_item.rich_text),
      };
    case "numbered_list_item":
      return {
        type: "numbered_list_item",
        text: getRichTextPlain(block.numbered_list_item.rich_text),
      };
    case "to_do":
      return {
        type: "to_do",
        text: getRichTextPlain(block.to_do.rich_text),
        checked: block.to_do.checked ?? false,
      };
    case "image":
      return {
        type: "image",
        imageUrl: getImageUrl(block) ?? undefined,
      };
    case "divider":
      return { type: "divider" };
    case "child_page":
      return { type: "child_page", text: block.child_page.title };
    case "child_database":
      return { type: "child_database", text: block.child_database.title };
    case "quote":
      return {
        type: "quote",
        text: getRichTextPlain(block.quote.rich_text),
      };
    case "callout":
      return {
        type: "callout",
        text: getRichTextPlain(block.callout.rich_text),
      };
    case "code":
      return {
        type: "code",
        text: getRichTextPlain(block.code.rich_text),
      };
    case "bookmark":
      return { type: "bookmark", text: block.bookmark.url };
    case "embed":
      return { type: "embed", text: block.embed.url };
    case "toggle":
      return {
        type: "toggle",
        text: getRichTextPlain(block.toggle.rich_text),
      };
    default:
      return null;
  }
}

// -- Cache (module-level, survives across requests in dev) --

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// `lru-cache` handles expiry (`ttl`) and bounding (`max`) — the old Map was
// unbounded and checked `Date.now()` by hand. Cached values are non-nullish
// query results, so a `get` returning `undefined` unambiguously means miss/expired.
const cache = new LRUCache<string, NonNullable<unknown>>({
  max: 100,
  ttl: CACHE_TTL,
});

/**
 * Transient Notion errors worth retrying (timeouts, gateway, rate limits).
 * Exported for unit testing — this classification is the behavior preserved
 * across the move to `p-retry`; the backoff/attempt-count timing is now
 * p-retry's responsibility, not ours.
 */
export function isRetryableNotionError(error: Error): boolean {
  return /timed out|504|502|rate_limited|429/.test(error.message);
}

// -- Client --

export class NotionClient {
  private client: Client;

  constructor(apiKey: string) {
    this.client = new Client({ auth: apiKey });
  }

  private async traced<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withTrace(TraceNames.api("notion", operation), fn);
  }

  private async cachedTrace<T>(
    key: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const cached = cache.get(key) as T | undefined;
    if (cached !== undefined) return cached;

    const result = await this.traced(operation, fn);
    cache.set(key, result as NonNullable<unknown>);
    return result;
  }

  /** Paginate through all results for a data source query. */
  private async queryAll(
    dataSourceId: string,
    opts?: {
      sorts?: Array<{
        property: string;
        direction: "ascending" | "descending";
      }>;
    },
  ): Promise<PageObjectResponse[]> {
    const pages: PageObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.queryWithRetry(dataSourceId, cursor, opts);
      pages.push(...extractPages(response));
      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    return pages;
  }

  /** Single page query with retry on 504/timeout. */
  private queryWithRetry(
    dataSourceId: string,
    cursor: string | undefined,
    opts?: {
      sorts?: Array<{
        property: string;
        direction: "ascending" | "descending";
      }>;
    },
  ): Promise<QueryDataSourceResponse> {
    // `p-retry` counts retries *after* the first attempt, so `retries: 2` =
    // 3 total attempts, with `minTimeout`/`factor` giving 1s then 2s backoff —
    // matching the old hand-rolled loop. Only transient errors are retried;
    // `shouldRetry: false` rejects with the original error for everything else.
    return pRetry(
      () =>
        this.client.dataSources.query({
          data_source_id: dataSourceId,
          page_size: 100,
          start_cursor: cursor,
          ...opts,
        }),
      {
        retries: 2,
        minTimeout: 1000,
        factor: 2,
        shouldRetry: ({ error }) => isRetryableNotionError(error),
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
          if (retriesLeft > 0 && isRetryableNotionError(error)) {
            console.warn(
              `[notion] Retry ${attemptNumber} (${retriesLeft} left): ${getErrorMessage(error)}`,
            );
          }
        },
      },
    );
  }

  async queryProjects(): Promise<NotionProject[]> {
    return this.cachedTrace("projects", "queryProjects", async () => {
      const pages = await this.queryAll(DATA_SOURCE_IDS.projects);

      return pages.map((page) => {
        const p = page.properties;
        return {
          id: page.id,
          name: getTitle(p.Name),
          status: getStatus(p.Status),
          kind: getSelect(p.kind),
          location: getMultiSelect(p.location),
          costEstimate: getNumber(p["cost estimate"]),
          date: getDateStart(p.Date),
          dateEnd: getDateEnd(p.Date),
          icon: getPageIcon(page),
          coverImage: getPageCover(page),
          blockedBy: getRelationIds(p["Blocked by"]),
          blocking: getRelationIds(p.Blocking),
          notionUrl: getPageUrl(page),
        };
      });
    });
  }

  async queryTasks(): Promise<NotionTask[]> {
    return this.cachedTrace("tasks", "queryTasks", async () => {
      const pages = await this.queryAll(DATA_SOURCE_IDS.tasks);

      return pages.map((page) => {
        const p = page.properties;
        return {
          id: page.id,
          name: getTitle(p.Name),
          status: getStatus(p.Status),
          due: getDateStart(p.Due),
          category: getSelect(p.category),
          projectName: getRelationId(p.project),
          notionUrl: getPageUrl(page),
        };
      });
    });
  }

  async queryPurchases(): Promise<NotionPurchase[]> {
    return this.cachedTrace("purchases", "queryPurchases", async () => {
      const pages = await this.queryAll(DATA_SOURCE_IDS.purchases, {
        sorts: [{ property: "Date", direction: "descending" }],
      });

      return pages.map((page) => {
        const p = page.properties;
        return {
          id: page.id,
          name: getTitle(p.Name),
          cost: getNumber(p.cost),
          date: getDateStart(p.Date),
          category: getSelect(p.category),
          subcategory: getSelect(p.subcategory),
          purchaser: getSelect(p.purchaser),
          projectName: getRelationId(p.Project),
          url: getUrl(p.URL),
          notionUrl: getPageUrl(page),
        };
      });
    });
  }

  /** All rows of the Recipes database (column metadata only; body via getPageContent). */
  async queryRecipes(): Promise<NotionRecipeRow[]> {
    return this.cachedTrace("recipes", "queryRecipes", async () => {
      const pages = await this.queryAll(DATA_SOURCE_IDS.recipes);

      return pages.map((page) => {
        const p = page.properties;
        return {
          id: page.id,
          name: getTitle(p.Name),
          source: getUrl(p.Source),
          // Optional columns — these helpers return null/[] when absent.
          yieldText: getRichText(p.Yield),
          servings: getNumber(p.Servings),
          tags: getMultiSelect(p.tags),
          notionUrl: getPageUrl(page),
        };
      });
    });
  }

  /** Fetch the first image from each project's page content. */
  async getProjectImages(pageIds: string[]): Promise<Record<string, string>> {
    return this.traced("getProjectImages", async () => {
      const images: Record<string, string> = {};

      await Promise.all(
        pageIds.map(async (pageId) => {
          try {
            const response = await this.client.blocks.children.list({
              block_id: pageId,
              page_size: 20,
            });
            for (const block of response.results) {
              if (!("type" in block)) continue;
              const url = getImageUrl(block as BlockObjectResponse);
              if (url) {
                images[pageId] = url;
                break;
              }
              // Check column children for images
              if (
                (block as BlockObjectResponse).type === "column_list" &&
                block.has_children
              ) {
                const columns = await this.client.blocks.children.list({
                  block_id: block.id,
                  page_size: 10,
                });
                for (const col of columns.results) {
                  if (!("type" in col) || !col.has_children) continue;
                  const colChildren = await this.client.blocks.children.list({
                    block_id: col.id,
                    page_size: 5,
                  });
                  for (const child of colChildren.results) {
                    if (!("type" in child)) continue;
                    const colUrl = getImageUrl(child as BlockObjectResponse);
                    if (colUrl) {
                      images[pageId] = colUrl;
                      return;
                    }
                  }
                }
                if (images[pageId]) return;
              }
            }
          } catch {
            // Skip pages that fail
          }
        }),
      );

      return images;
    });
  }

  /** Fetch page content blocks for rendering. */
  async getPageContent(pageId: string): Promise<NotionBlock[]> {
    return this.cachedTrace(
      `pageContent:${pageId}`,
      `getPageContent`,
      async () => {
        const blocks: NotionBlock[] = [];
        let cursor: string | undefined;

        do {
          const response: ListBlockChildrenResponse =
            await this.client.blocks.children.list({
              block_id: pageId,
              page_size: 100,
              start_cursor: cursor,
            });

          for (const block of response.results) {
            if (!("type" in block)) continue;
            const typed = block as BlockObjectResponse;

            // Handle column lists by flattening
            if (typed.type === "column_list" && typed.has_children) {
              const columns = await this.client.blocks.children.list({
                block_id: typed.id,
                page_size: 10,
              });
              const columnChildren: NotionBlock[] = [];
              for (const col of columns.results) {
                if (!("type" in col) || !col.has_children) continue;
                const children = await this.client.blocks.children.list({
                  block_id: col.id,
                  page_size: 50,
                });
                for (const child of children.results) {
                  if (!("type" in child)) continue;
                  const nb = blockToNotionBlock(child as BlockObjectResponse);
                  if (nb) columnChildren.push(nb);
                }
              }
              if (columnChildren.length > 0) {
                blocks.push({ type: "columns", children: columnChildren });
              }
              continue;
            }

            const nb = blockToNotionBlock(typed);
            if (nb) blocks.push(nb);
          }

          cursor = response.has_more
            ? (response.next_cursor ?? undefined)
            : undefined;
        } while (cursor);

        return blocks;
      },
    );
  }
}
