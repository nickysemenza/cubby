import { allEntities } from "@cubby/schemas/entity-manifest";

/**
 * Cache policy vocabulary that contract members may name. Contracts carry
 * cache policy as DATA only (tag lists, a profile name, ripple keys); the
 * browser catalog generator resolves it to descriptors. No React, no query
 * client, no functions of the input.
 */

/** A semantic cache tag. Matching is prefix-only (see `operation-tags` tests). */
export type CacheTag = readonly [string, ...string[]];

/** Named freshness behavior a query opts into; resolved in `query-policy.ts`. */
export type CacheProfile =
  | "interactive"
  | "live-status"
  | "browse"
  | "stable"
  | "derived-summary"
  | "persisted-detail";

/**
 * Names a row of the browser's invalidation fan-out table (`ripple` in
 * `integrations/tanstack-query/cache-tags.ts`, which is checked against this
 * union in both directions). A mutation's `invalidates` lists the rows it
 * ripples through; an empty list is a deliberate no-op.
 */
export type RippleKey =
  | "planting"
  | "gardenEntry"
  | "search"
  | "maintenance"
  | "problemsSearch"
  | "recommendations"
  | "collection"
  | "connectedApps"
  | "orphanedOAuth"
  | "calendarFeed"
  | "calendarCredential"
  | "calendar"
  | "relatednessProduct"
  | "projectOnly"
  | "runOnly"
  | "vendorAccountOnly"
  | "memberLogins"
  | "productOnly"
  | "recommendationPlacement"
  | "recommendationTagPropagation"
  | "product"
  | "productCategory"
  | "productMerge"
  | "productRecipe"
  | "productLookup"
  | "productComponent"
  | "inventory"
  | "location"
  | "locationReparent"
  | "image"
  | "imageCull"
  | "usda-food"
  | "ingredient"
  | "ingredientProduct"
  | "ingredientProductUsdaFood"
  | "ingredientMerge"
  | "ingredientCleanup"
  | "recipe"
  | "recipeList"
  | "recipeCookbook"
  | "cookbook"
  | "cookbookProductLink"
  | "meal"
  | "project"
  | "projectResource"
  | "task"
  | "taskProject"
  | "spendingCategory"
  | "expense"
  | "vendor"
  | "vendorMerge"
  | "vendorLogo"
  | "purchase"
  | "purchaseProduct"
  | "financialAccount"
  | "ledgerParty"
  | "ledgerTransfer"
  | "financialTransaction"
  | "wish"
  | "statementRow"
  | "problems";

/** The cache policy of a query member. */
export interface QueryCachePolicy {
  /**
   * Tags this query answers to. Omitted, the query is tagged
   * `[domain, member]`; an empty list opts out of tagging entirely.
   */
  readonly tags?: readonly CacheTag[];
  readonly profile?: CacheProfile;
}

/**
 * One root tag per manifest entity, for queries that may read through any
 * relationship and so must refresh whenever any entity moves.
 */
export const ENTITY_ROOT_TAGS: readonly CacheTag[] = allEntities.map(
  (entity): CacheTag => [entity],
);
