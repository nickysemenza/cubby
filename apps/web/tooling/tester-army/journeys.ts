import { JOURNEY_NAMES, LIVE_IMPORT } from "./names";
import type { DbCheck, Journey, JourneyIds, RunWait } from "./journey";

/**
 * Every journey, described once. The agent follows the goals on whichever
 * engine runs them; the exact text and the database read-backs decide the
 * verdict. Keep goals in the words visible on screen. Add `web`/`ios` on a
 * step only when the two clients genuinely label a control differently.
 */

const stock = `SELECT l.name AS location, ie."amountValue"::float8 AS amount, count(*) OVER ()::int AS entries
   FROM "InventoryEntry" ie
   JOIN "Product" p ON p.id = ie."productId"
   JOIN "Location" l ON l.id = ie."locationId"
   WHERE p.shortcode = $1 AND ie."deletedAt" IS NULL`;

const only = (key: string) => (ids: JourneyIds) => [ids.get(key)];

const expensePurchase = (key: string): DbCheck => ({
  label: "expense belongs to the expected purchase",
  sql: `SELECT p.shortcode AS purchase FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE e.shortcode = $1 AND e."deletedAt" IS NULL`,
  params: only("expense"),
  rows: (ids) => [{ purchase: ids.get(key) }],
});

const purchaseParts = (parts: number, cents: number): DbCheck => ({
  label: "purchase has the expected live expense parts",
  sql: `SELECT count(*)::int AS parts, COALESCE(round(sum(e.cost) * 100), 0)::int AS cents
        FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId"
        WHERE p.shortcode = $1 AND e."deletedAt" IS NULL`,
  params: only("purchase"),
  rows: () => [{ parts, cents }],
});

/** The vendor's purchases, each with its order id and summed expense cents. */
const importedOrder = (orderId: string, cents: number): DbCheck => ({
  label: "the vendor's one purchase carries the source order and amount",
  sql: `SELECT p."orderId", round(sum(e.cost) * 100)::int AS cents
          FROM "Purchase" p
          JOIN "Vendor" v ON v.id = p."vendorId"
          JOIN "Expense" e ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
         WHERE v.shortcode = $1 AND p."deletedAt" IS NULL
         GROUP BY p.id, p."orderId"`,
  params: only("vendor"),
  rows: () => [{ orderId, cents }],
});

/** A live coordinator run: minutes of real model turns, never instant. */
const LIVE_RUN_MS = 480_000;

const vendorRun = (until: RunWait["until"]): RunWait => ({
  sql: `SELECT r.id FROM "Run" r JOIN "Vendor" v ON v.id = r."vendorId"
         WHERE v.shortcode = $1 ORDER BY r."startedAt" DESC LIMIT 1`,
  params: only("vendor"),
  until,
  timeoutMs: LIVE_RUN_MS,
});

const photoRun = (until: RunWait["until"]): RunWait => ({
  sql: `SELECT id FROM "Run" WHERE shortcode = $1`,
  params: only("run"),
  until,
  timeoutMs: LIVE_RUN_MS,
});

/** The run the member started again from the seeded, finished sync. */
const successorRun = (until: RunWait["until"]): RunWait => ({
  sql: `SELECT r.id FROM "Run" r JOIN "Run" prior ON prior.id = r."predecessorRunId"
         WHERE prior.shortcode = $1`,
  params: only("run"),
  until,
  timeoutMs: LIVE_RUN_MS,
});

/**
 * Journeys on the coupled harness: nothing behind the browser is scripted
 * except the synthetic sources (a saved confirmation, uploaded photos, and a
 * simulated Mac browser answering by URL). The coordinator, extraction,
 * audit, and image description call real models.
 */
const coupledJourneys: Journey[] = [
  {
    id: "import-order-mail",
    title: "import a saved order confirmation through the live agent",
    coupled: true,
    timeoutMs: 600_000,
    context:
      "A vendor page lists saved order confirmation emails; each importable order has an Import order button, which starts an agent run and then shows a View import link to that run's page.",
    start: "vendor",
    steps: [
      {
        goal: `Import the saved order confirmation for order ${LIVE_IMPORT.mail.orderId}, then open the import it starts.`,
        // The run page streams the coordinator's live conversation.
        check: { visible: () => ["Live agent"] },
      },
    ],
    awaitRun: vendorRun("completed"),
    visible: () => ["Purchases changed"],
    db: [importedOrder(LIVE_IMPORT.mail.orderId, LIVE_IMPORT.mail.cents)],
  },
  {
    id: "import-photo-inventory",
    title: "group uploaded photos into items and approve them",
    coupled: true,
    timeoutMs: 900_000,
    context:
      "A photo import run page shows photo processing progress, a Start grouping button once cloud descriptions are ready, and the agent's proposed item groups, each with an Approve button.",
    start: "run",
    steps: [
      {
        ready: {
          label: "every uploaded photo has a cloud description",
          // `lastError` puts a failing description's cause in the assertion.
          sql: `SELECT j.state, j."lastError", count(*)::int AS photos
                  FROM "ImageProcessingJob" j
                  JOIN "RunTarget" t ON t."entityId" = j."imageId"
                  JOIN "Run" r ON r.id = t."runId"
                 WHERE r.shortcode = $1 AND j.kind = 'describe_image'
                 GROUP BY j.state, j."lastError"`,
          params: only("run"),
          rows: () => [
            {
              state: "ready",
              lastError: null,
              photos: LIVE_IMPORT.photos.length,
            },
          ],
          timeoutMs: 240_000,
        },
        goal: "Select Start grouping, then finish once the page says the agent is preparing item groups.",
      },
      {
        awaitRun: photoRun("awaiting_approval"),
        goal: "Approve every proposed item group on this page, one group at a time, until none is left to approve.",
      },
    ],
    awaitRun: photoRun("completed"),
    visible: () => ["Review complete"],
    db: [
      {
        label: "every photo is settled on a committed item",
        sql: `SELECT t.state, count(*)::int AS photos
                FROM "RunTarget" t JOIN "Run" r ON r.id = t."runId"
               WHERE r.shortcode = $1 GROUP BY t.state`,
        params: only("run"),
        rows: () => [{ state: "completed", photos: LIVE_IMPORT.photos.length }],
      },
      {
        // Each uploaded photo is in the gallery of the live Product its
        // committed group names, and the two photos name two Products.
        label: "each photo is in its committed item's product gallery",
        sql: `SELECT count(DISTINCT p.id)::int AS products,
                     count(DISTINCT a."imageId")::int AS photos
                FROM "PhotoGroupProposal" g
                JOIN "Run" r ON r.id = g."runId"
                JOIN "Product" p ON p.id = g."productId" AND p."deletedAt" IS NULL
                JOIN "RunTarget" t ON t."runId" = r.id
                JOIN "EntityAttachment" a
                  ON a."imageId" = t."entityId" AND a."entityId" = p.id
                 AND a."entityKind" = 'product' AND a."deletedAt" IS NULL
               WHERE r.shortcode = $1 AND g.state = 'committed'`,
        params: only("run"),
        rows: () => [
          {
            products: LIVE_IMPORT.photos.length,
            photos: LIVE_IMPORT.photos.length,
          },
        ],
      },
    ],
  },
  {
    id: "import-account-sync",
    title: "sync a vendor account through the browser and import its order",
    coupled: true,
    timeoutMs: 900_000,
    context:
      "A finished import run page offers Start new run with same inputs, which starts a new run for the same vendor account and opens it.",
    start: "run",
    steps: [
      {
        goal: "Start a new run with the same inputs, then open the new run.",
        check: { visible: () => ["Live agent"] },
      },
    ],
    awaitRun: successorRun("completed"),
    visible: () => ["Purchases changed"],
    db: [
      importedOrder(LIVE_IMPORT.sync.orderId, LIVE_IMPORT.sync.cents),
      {
        label: "the order listed on the history page was imported",
        sql: `SELECT c."orderId", c.state
                FROM "RunOrderCandidate" c
                JOIN "Run" r ON r.id = c."runId"
                JOIN "Run" prior ON prior.id = r."predecessorRunId"
               WHERE prior.shortcode = $1`,
        params: only("run"),
        rows: () => [{ orderId: LIVE_IMPORT.sync.orderId, state: "imported" }],
      },
    ],
  },
];

export const journeys: Journey[] = [
  {
    id: "product-rename",
    title: "product rename persists after reopening",
    start: "product",
    steps: [
      {
        goal: `Edit this product, change its Name to "${JOURNEY_NAMES.productUpdatedName}", and save. Wait for the product detail to show the new name before you finish.`,
      },
    ],
    visible: () => [JOURNEY_NAMES.productUpdatedName],
    db: [
      {
        label: "product name",
        sql: `SELECT name FROM "Product" WHERE shortcode = $1 AND "deletedAt" IS NULL`,
        params: only("product"),
        rows: () => [{ name: JOURNEY_NAMES.productUpdatedName }],
      },
    ],
  },
  {
    id: "receive-purchase",
    title: "receive a purchase into stock without decrementing",
    start: "expense",
    steps: [
      {
        goal: `Receive this expense into Inventory: pick the location "${JOURNEY_NAMES.receiveShelf}", set the quantity to add to 3, and confirm Receive.`,
      },
    ],
    visible: () => [],
    db: [
      {
        label: "one stock entry of 3 at the chosen location",
        sql: stock,
        params: only("product"),
        rows: () => [
          { location: JOURNEY_NAMES.receiveShelf, amount: 3, entries: 1 },
        ],
      },
      {
        label: "receiving left the expense untouched",
        sql: `SELECT cost::float8 AS cost, "productQuantity"::float8 AS quantity FROM "Expense" WHERE shortcode = $1`,
        params: only("expense"),
        rows: () => [{ cost: 30, quantity: 3 }],
      },
    ],
  },
  {
    id: "hero-add-inventory",
    title: "hero action: add a product to inventory",
    start: "product",
    steps: [
      {
        goal: `Use the "Add to inventory" action on this product: choose the location "${JOURNEY_NAMES.inventoryShelf}", set the amount to 4, and submit.`,
      },
    ],
    visible: () => [],
    db: [
      {
        label: "one stock entry of 4",
        sql: stock,
        params: only("product"),
        rows: () => [
          { location: JOURNEY_NAMES.inventoryShelf, amount: 4, entries: 1 },
        ],
      },
    ],
  },
  {
    id: "hero-record-sale",
    title: "hero action: record a sale with disposition defaults",
    start: "product",
    steps: [
      {
        // A sale has no project or purchase to inherit a trade from, and the server requires one
        // on a principal line, so the goal names it rather than leaving the agent to improvise.
        goal: 'Use the Record sale action on this product: name it "Synthetic chair sale", enter a cost of -12.50, set Trade to "Appliances & Furniture", and save the new expense.',
      },
    ],
    visible: () => [],
    db: [
      {
        label: "sale expense with disposition defaults",
        sql: `SELECT e.cost::float8 AS cost, e."costType" AS "costType", e."lineKind" AS "lineKind", e.trade, (e."projectId" IS NULL) AS "noProject"
              FROM "Expense" e JOIN "Product" p ON p.id = e."productId"
              WHERE p.shortcode = $1 AND e."deletedAt" IS NULL`,
        params: only("product"),
        rows: () => [
          {
            cost: -12.5,
            costType: "tools",
            lineKind: "principal",
            trade: "appliances",
            noProject: true,
          },
        ],
      },
    ],
  },
  {
    id: "hero-set-status",
    title: "hero action: set a project status",
    start: "project",
    steps: [
      {
        goal: 'Use the Set status action to set this project to "In progress".',
      },
    ],
    visible: () => [],
    db: [
      {
        label: "project status",
        sql: `SELECT status FROM "Project" WHERE shortcode = $1`,
        params: only("project"),
        rows: () => [{ status: "in_progress" }],
      },
    ],
  },
  {
    id: "hero-mark-purchased",
    title: "hero action: mark a wish purchased",
    start: "wish",
    steps: [{ goal: "Use the Mark purchased action on this wish." }],
    visible: () => [],
    db: [
      {
        label: "wish acquired",
        sql: `SELECT ("acquiredAt" IS NOT NULL) AS acquired FROM "Wish" WHERE shortcode = $1`,
        params: only("wish"),
        rows: () => [{ acquired: true }],
      },
    ],
  },
  {
    id: "hero-delete-task",
    title: "hero action: delete a task after the impact preview",
    start: "task",
    steps: [
      {
        goal: "Open the Delete action for this task and stop at the impact preview. Do not confirm yet.",
        check: {
          visible: () => ["Synthetic Delete Project"],
          db: [
            {
              label: "preview writes nothing",
              sql: `SELECT ("deletedAt" IS NOT NULL) AS deleted FROM "Task" WHERE shortcode = $1`,
              params: only("task"),
              rows: () => [{ deleted: false }],
            },
          ],
        },
      },
      { goal: "Now confirm the deletion." },
    ],
    visible: () => [],
    db: [
      {
        label: "task soft-deleted",
        sql: `SELECT ("deletedAt" IS NOT NULL) AS deleted FROM "Task" WHERE shortcode = $1`,
        params: only("task"),
        rows: () => [{ deleted: true }],
      },
    ],
  },
  {
    id: "field-product-tags",
    title: "editing product tags keeps collection assignments",
    start: "product",
    steps: [
      {
        goal: 'Edit this product, add the tag "synthetic-new-tag" to its Tags while keeping the existing tags, and save.',
      },
    ],
    visible: () => ["synthetic-new-tag"],
    db: [
      {
        label: "tags plus untouched collection entry",
        sql: `SELECT array_agg(t ORDER BY t) AS tags FROM "Product", unnest(tags) AS t WHERE shortcode = $1`,
        params: only("product"),
        rows: () => [
          {
            tags: [
              "collection:synthetic-shelf",
              "synthetic-new-tag",
              "synthetic-old-tag",
            ],
          },
        ],
      },
    ],
  },
  {
    id: "field-source-alias",
    title: "financial account source alias editing",
    start: "account",
    steps: [
      {
        goal: 'Edit this account, add a source alias with Source "synthetic-bank" and Alias "SYN CHK 1234", leave the external ID empty, and save.',
      },
    ],
    visible: () => ["SYN CHK 1234"],
    db: [
      {
        label: "alias stored",
        sql: `SELECT "sourceAliases" AS aliases FROM "FinancialAccount" WHERE shortcode = $1`,
        params: only("account"),
        rows: () => [
          {
            aliases: [
              {
                source: "synthetic-bank",
                alias: "SYN CHK 1234",
                externalAccountId: null,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "field-source-claim",
    title: "source claim description edit preserves identity",
    start: "expense",
    steps: [
      {
        goal: 'Edit this expense and change the description of its source claim to "Synthetic claim evidence revised", then save.',
      },
    ],
    visible: () => [],
    db: [
      {
        label: "same claim row and key, new description",
        sql: `SELECT c.id::text AS id, c."sourceKey" AS "sourceKey", c."normalizedEvidence"->>'description' AS description, count(*) OVER ()::int AS claims
              FROM "LedgerSourceClaim" c JOIN "Expense" e ON e.id = c."expenseId"
              WHERE e.shortcode = $1 AND c."deletedAt" IS NULL`,
        params: only("expense"),
        rows: (ids) => [
          {
            id: ids.get("claimId"),
            sourceKey: ids.get("sourceKey"),
            description: "Synthetic claim evidence revised",
            claims: 1,
          },
        ],
      },
    ],
  },
  {
    id: "field-label-nutrition",
    title: "edit product label nutrition",
    start: "product",
    steps: [
      {
        goal: "Edit this product's label nutrition: change the Calories amount from 120 to 150, keep everything else, and save.",
      },
    ],
    visible: () => [],
    db: [
      {
        label: "calories changed, protein and serving kept",
        sql: `SELECT ("labelNutrition"->>'servingGrams')::float8 AS serving, ("labelNutrition"->'nutrients'->>'kcal')::float8 AS kcal, ("labelNutrition"->'nutrients'->>'protein')::float8 AS protein FROM "Product" WHERE shortcode = $1`,
        params: only("product"),
        rows: () => [{ serving: 30, kcal: 150, protein: 3 }],
      },
    ],
  },
  {
    id: "field-external-ids",
    title: "add a product external id",
    start: "product",
    steps: [
      {
        goal: 'Edit this product and add an external ID with Source "synthetic-shop", Kind "ASIN" and Identifier "B0SYNTH001", then save.',
      },
    ],
    visible: () => ["B0SYNTH001"],
    db: [
      {
        label: "external id stored",
        sql: `SELECT x.source, x.kind, x."externalId" AS "externalId" FROM "EntityExternalId" x JOIN "Product" p ON p.id = x."entityId" WHERE p.shortcode = $1 AND x."deletedAt" IS NULL`,
        params: only("product"),
        rows: () => [
          { source: "synthetic-shop", kind: "asin", externalId: "B0SYNTH001" },
        ],
      },
    ],
  },
  {
    id: "field-source-refs",
    title: "add a transaction source ref",
    start: "transaction",
    steps: [
      {
        goal: 'Edit this transaction and add a source ref with Source "synthetic-bank" and External ID "SYN-REF-1", then save.',
      },
    ],
    visible: () => ["SYN-REF-1"],
    db: [
      {
        label: "settlement ref stored",
        sql: `SELECT x.source, x.kind, x."externalId" AS "externalId" FROM "EntityExternalId" x JOIN "FinancialTransaction" t ON t.id = x."entityId" WHERE t.shortcode = $1 AND x."deletedAt" IS NULL`,
        params: only("transaction"),
        rows: () => [
          {
            source: "synthetic-bank",
            kind: "settlement_ref",
            externalId: "SYN-REF-1",
          },
        ],
      },
    ],
  },
  {
    id: "related-purchase-validate",
    title: "validate a purchase with no evidence starts a search run",
    start: "purchase",
    steps: [
      {
        goal: "Under the purchase's runs, use Validate ingestion without choosing any evidence to replay, and start it.",
      },
    ],
    visible: () => [],
    db: [
      {
        label: "one validation run targeting the purchase",
        sql: `SELECT r.purpose, r.trigger FROM "Run" r JOIN "RunTarget" t ON t."runId" = r.id JOIN "Purchase" p ON p.id = t."entityId" WHERE p.shortcode = $1`,
        params: only("purchase"),
        rows: () => [{ purpose: "purchase_validation", trigger: "manual" }],
      },
    ],
  },
  {
    id: "run-console",
    title: "run console shows progress and resolves a finding",
    start: "run",
    steps: [
      {
        goal: "Read the run's live progress, then dismiss the finding that says it is a synthetic finding to resolve.",
        check: {
          visible: () => ["Reading synthetic orders", "Synthetic order 7"],
        },
      },
    ],
    visible: () => [],
    db: [
      {
        label: "finding dismissed and stamped",
        sql: `SELECT f.status, (f."resolvedAt" IS NOT NULL) AS resolved FROM "RunFinding" f JOIN "Run" r ON r.id = f."runId" WHERE r.shortcode = $1`,
        params: only("run"),
        rows: () => [{ status: "dismissed", resolved: true }],
      },
    ],
  },
  {
    id: "field-recipe-line",
    title: "recipe section ingredient line edit",
    start: "recipe",
    steps: [
      {
        goal: "Edit this recipe and change the flour ingredient amount from 250 g to 300 g, then save.",
      },
    ],
    visible: () => [],
    db: [
      {
        label: "line amount",
        sql: `SELECT rsi.amounts AS amounts FROM "RecipeSectionIngredient" rsi
              JOIN "RecipeSection" rs ON rs.id = rsi."recipeSectionId"
              JOIN "Recipe" r ON r.id = rs."recipeId" WHERE r.shortcode = $1`,
        params: only("recipe"),
        rows: () => [{ amounts: [{ value: 300, unit: "g" }] }],
      },
    ],
  },
  {
    id: "finance-split-expense",
    title: "split an expense conserving cents",
    start: "expense",
    steps: [
      {
        goal: 'Split this expense into two parts: "Synthetic part one" costing 6.00 and "Synthetic part two" costing 4.00, then confirm. If the app does not allow it because the parts do not add up to the original cost, stop there.',
        check: {
          visible: () => ["add up to the original cost exactly"],
          db: [purchaseParts(1, 1001)],
        },
      },
      {
        goal: "Fix the split so the two parts add up exactly: part two costs 4.01. Confirm the split.",
      },
    ],
    visible: () => [],
    db: [purchaseParts(2, 1001)],
  },
  {
    id: "finance-split-unknown-cost",
    title: "splitting an expense with unknown cost is refused",
    start: "expense",
    steps: [
      {
        goal: "Try to split this expense into two parts without entering any costs, and confirm the split. Stop when the app refuses.",
      },
    ],
    visible: () => ["enter a cost"],
    db: [purchaseParts(1, 0)],
  },
  {
    id: "finance-attach-expenses",
    title:
      "attach an expense from another purchase after the move confirmation",
    start: "purchase",
    steps: [
      {
        goal: 'Attach existing expenses to this purchase: select "Synthetic movable expense", wait for the Attach button to become enabled, and press it once. The app then warns that the expense moves off another purchase; stop there and do not press the confirming button.',
        check: { db: [expensePurchase("otherPurchase")] },
      },
      { goal: "Confirm the move: press the confirming Attach button." },
    ],
    visible: () => [],
    db: [expensePurchase("purchase")],
  },
  {
    id: "finance-attach-products",
    title: "attach a product to a purchase",
    start: "purchase",
    steps: [
      {
        goal: 'Attach products to this purchase: choose "Synthetic Attachable Sieve" and attach it.',
      },
    ],
    visible: () => ["Synthetic Attachable Sieve"],
    db: [
      {
        label: "purchaseProduct link",
        sql: `SELECT count(*)::int AS links FROM "EntityLink" el
              JOIN "Purchase" p ON p.id = el."fromEntityId"
              JOIN "Product" pr ON pr.id = el."toEntityId"
              WHERE p.shortcode = $1 AND pr.shortcode = $2 AND el."deletedAt" IS NULL`,
        params: (ids) => [ids.get("purchase"), ids.get("product")],
        rows: () => [{ links: 1 }],
      },
    ],
  },
  {
    id: "board-move-card",
    title: "task board lanes and moving a card",
    open: () => ({ web: "/tasks?view=board&cols=project" }),
    steps: [
      {
        goal: `Open the task board grouped by project. Confirm the lanes include "Inbox" and "${JOURNEY_NAMES.boardProjectA}".`,
        web: `This is the task board with lanes grouped by project. Confirm the lanes include "Inbox" and "${JOURNEY_NAMES.boardProjectA}".`,
        check: {
          visible: () => ["Inbox", JOURNEY_NAMES.boardProjectA],
        },
      },
      {
        goal: `Move the card "Synthetic inbox card" from Inbox into the "${JOURNEY_NAMES.boardProjectA}" lane.`,
      },
    ],
    visible: () => [],
    db: [
      {
        label: "task moved into project A",
        sql: `SELECT pr.name AS project FROM "Task" t JOIN "Project" pr ON pr.id = t."projectId" WHERE t.shortcode = $1`,
        params: only("task"),
        rows: () => [{ project: JOURNEY_NAMES.boardProjectA }],
      },
    ],
  },
  ...coupledJourneys,
];
