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

// Data source IDs (collection:// URLs). Only the Recipes database remains —
// the projects/tasks/expenses trackers were migrated into cubby tables and
// deleted from Notion.
const DATA_SOURCE_IDS = {
  // The "Recipes" database under Food → Recipes. Synced into Cubby recipes.
  recipes: "69f477cf-b5dd-4151-8508-8c8d1be19706",
} as const;

// -- Output types --
// Zod-sourced so the procedure `.output()` schemas (api/routers/notion.ts) and
// these types share one definition.

export type NotionBlock = {
  type: string;
  text?: string;
  checked?: boolean;
  imageUrl?: string;
  children?: NotionBlock[];
};

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

function getPageUrl(page: PageObjectResponse): string {
  return page.url;
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
const recipeCache = new LRUCache<string, NotionRecipeRow[]>({
  max: 100,
  ttl: CACHE_TTL,
});
const blockCache = new LRUCache<string, NotionBlock[]>({
  max: 100,
  ttl: CACHE_TTL,
});

type BlockResult = ListBlockChildrenResponse["results"][number];
const isBlockObjectResponse = (
  block: BlockResult,
): block is BlockObjectResponse => "type" in block;

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

  private async cachedTrace<T extends NonNullable<unknown>>(
    targetCache: LRUCache<string, T>,
    key: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const cached = targetCache.get(key);
    if (cached !== undefined) return cached;

    const result = await this.traced(operation, fn);
    targetCache.set(key, result);
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

  /** All rows of the Recipes database (column metadata only; body via getPageContent). */
  async queryRecipes(): Promise<NotionRecipeRow[]> {
    return this.cachedTrace(
      recipeCache,
      "recipes",
      "queryRecipes",
      async () => {
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
      },
    );
  }

  /** Fetch page content blocks for rendering. */
  async getPageContent(pageId: string): Promise<NotionBlock[]> {
    return this.cachedTrace(
      blockCache,
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
            if (!isBlockObjectResponse(block)) continue;
            const typed = block;

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
                  if (!isBlockObjectResponse(child)) continue;
                  const nb = blockToNotionBlock(child);
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
