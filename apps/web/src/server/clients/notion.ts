import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints/common";
import type { QueryDataSourceResponse } from "@notionhq/client/build/src/api-endpoints/data-sources";

// Data source IDs from the Notion "Project Tracker" page (collection:// URLs)
const DATA_SOURCE_IDS = {
  projects: "359f9bad-4815-4a9a-8de9-c6072e8fb5f2",
  tasks: "7c203038-5c1a-411a-8019-5698643c0394",
  purchases: "85bb653f-15a5-44d7-8389-93c93202219a",
} as const;

// -- Output types --

export type NotionProject = {
  id: string;
  name: string;
  status: string | null;
  kind: string | null;
  location: string[];
  costEstimate: number | null;
  date: string | null;
  notionUrl: string;
};

export type NotionTask = {
  id: string;
  name: string;
  status: string | null;
  due: string | null;
  category: string | null;
  projectName: string | null;
  notionUrl: string;
};

export type NotionPurchase = {
  id: string;
  name: string;
  cost: number | null;
  date: string | null;
  category: string | null;
  subcategory: string | null;
  purchaser: string | null;
  projectName: string | null;
  url: string | null;
  notionUrl: string;
};

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

function getUrl(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "url") {
    return prop.url;
  }
  return null;
}

function getRelationId(prop: PropertyValue | undefined): string | null {
  if (prop?.type === "relation" && prop.relation.length > 0) {
    return prop.relation[0].id;
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

// -- Client --

export class NotionClient {
  private client: Client;

  constructor(apiKey: string) {
    this.client = new Client({ auth: apiKey });
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
      const response = await this.client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        start_cursor: cursor,
        ...opts,
      });
      pages.push(...extractPages(response));
      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    return pages;
  }

  async queryProjects(): Promise<NotionProject[]> {
    const pages = await this.queryAll(DATA_SOURCE_IDS.projects);

    return pages.map((page) => {
      const p = page.properties;
      return {
        id: page.id,
        name: getTitle(p["Name"]),
        status: getStatus(p["Status"]),
        kind: getSelect(p["kind"]),
        location: getMultiSelect(p["location"]),
        costEstimate: getNumber(p["cost estimate"]),
        date: getDateStart(p["Date"]),
        notionUrl: getPageUrl(page),
      };
    });
  }

  async queryTasks(): Promise<NotionTask[]> {
    const pages = await this.queryAll(DATA_SOURCE_IDS.tasks);

    return pages.map((page) => {
      const p = page.properties;
      return {
        id: page.id,
        name: getTitle(p["Name"]),
        status: getStatus(p["Status"]),
        due: getDateStart(p["Due"]),
        category: getSelect(p["category"]),
        projectName: getRelationId(p["project"]),
        notionUrl: getPageUrl(page),
      };
    });
  }

  async queryPurchases(): Promise<NotionPurchase[]> {
    const pages = await this.queryAll(DATA_SOURCE_IDS.purchases, {
      sorts: [{ property: "Date", direction: "descending" }],
    });

    return pages.map((page) => {
      const p = page.properties;
      return {
        id: page.id,
        name: getTitle(p["Name"]),
        cost: getNumber(p["cost"]),
        date: getDateStart(p["Date"]),
        category: getSelect(p["category"]),
        subcategory: getSelect(p["subcategory"]),
        purchaser: getSelect(p["purchaser"]),
        projectName: getRelationId(p["Project"]),
        url: getUrl(p["URL"]),
        notionUrl: getPageUrl(page),
      };
    });
  }
}
