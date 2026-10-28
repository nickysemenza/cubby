import type { Entity } from "./entity";
import { connectedPathVariants } from "./connected-views";
import { localRelationshipByKey } from "./entity-manifest";
import {
  compileRelatedViewRegistry,
  type RelatedViewDefinition,
} from "./related-view";

export const relatedViewRegistry = compileRelatedViewRegistry(
  localRelationshipByKey,
);

/** Every declared evidence source participates in previews and filters. */
export const relatedViewPaths = (
  view: Pick<RelatedViewDefinition, "source" | "key">,
) => {
  const definition = relatedViewRegistry.find(
    (candidate) =>
      candidate.key === view.key && candidate.source === view.source,
  );
  if (!definition) throw new Error(`Unknown related view key: ${view.key}`);
  return connectedPathVariants(view.source, [definition.relationship]).map(
    (variant) => variant.steps,
  );
};

type RelatedViewSource = (typeof relatedViewRegistry)[number]["source"];

/**
 * Entities that deliberately offer no curated related views, each with the
 * reason. `satisfies Record<Exclude<Entity, RelatedViewSource>, string>` makes
 * this the exact complement of the registry's sources, in both directions: a
 * new entity that is neither a source nor listed here fails to compile, and an
 * entity that gains its first registry row must be deleted from here. Before
 * this, an entity with no views and an entity nobody had gotten to were the
 * same empty `.filter()` result.
 */
const ENTITIES_WITHOUT_RELATED_VIEWS = {
  shipment:
    "Purchase and carrier render as declared Shipment references; tracking evidence uses the timeline report.",
  sourceTransactionRecord:
    "Imports and accepted transactions render as detail relation sections.",
  transactionImport:
    "Retained source records render as a detail relation section.",
  email:
    "Email report generic records derive accepted source-family/lifecycle Purchases, their Expenses/Products and same-Purchase owned Emails; mailbox-scoped thread context and dismissed candidates remain separate. Owner/Run use declared related views.",
  spendingCategory:
    "Spending classification links are rendered on each financial record.",
  cookbook: "the cookbook page IS its recipe list",
  ledgerTransfer:
    "ledger transfer relationships are rendered in the household ledger",
  // The one entity with no shortcode, no detail route, and no list table.
  image: "no detail route or list table to hang a preview column on",
  plant: "a plant's plantings and products render as detail relation sections",
  planting:
    "its cross-entity relationships (ingredient, location, source product, task) are already reachable from those entities' own relation sections",
  gardenEntry: "garden timelines render entries directly",
  run: "read-only runs have no detail route to hang a related view on; vendor account/vendor/member links are rendered as list columns",
  productCategory:
    "the category tree is rendered through the product-category records page",
  // Not a local entity — remote USDA search results, no local edges.
  "usda-food": "remote USDA records have no local relationships",
  device:
    "owner and hardware are rendered as detail fields; nothing yet declares a relation onto a device",
  imageJob:
    "an Image job's Image and requesting Run are detail fields; its attempts and events are the attempts slot",
  job: "Execution subjects and Runs are read-only reference fields; Activity embeds the Job roster directly.",
} as const satisfies Record<Exclude<Entity, RelatedViewSource>, string>;

type RegisteredRelatedView = (typeof relatedViewRegistry)[number];

const NO_RELATED_VIEWS: readonly RegisteredRelatedView[] = [];

export const relatedViewsFor = (
  entity: Entity,
): readonly RegisteredRelatedView[] =>
  entity in ENTITIES_WITHOUT_RELATED_VIEWS
    ? NO_RELATED_VIEWS
    : relatedViewRegistry.filter((view) => view.source === entity);
