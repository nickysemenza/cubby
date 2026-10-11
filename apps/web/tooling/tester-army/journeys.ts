import { z } from "zod";

import { JOURNEY_NAMES, LIVE_IMPORT } from "./names";
import type {
  DbCheck,
  Journey,
  JourneyIds,
  JourneyStep,
  RunWait,
} from "./journey";

/**
 * Every journey, described once. The agent follows the goals on whichever
 * engine runs them; the exact text and the database read-backs decide the
 * verdict. Keep goals in the words visible on screen. Add `web`/`ios` on a
 * step for different labels or supported interaction phases. End goals name
 * observable states; exact read-back establishes persistence.
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

/** Explicit Email import links only the selected source, attributed to its Run actor. */
const mailImportFollowUps = (
  source: (typeof LIVE_IMPORT)["mail"],
): DbCheck[] => [
  {
    label:
      "only the selected confirmation links, with the admitted actor and source checksum",
    sql: `SELECT e.event, d."decidedByUserId" = r."actorUserId" AS "actorMatches",
                 d."evidenceChecksum" = m."rawChecksum" AS "sourceMatches", p."orderId"
            FROM "OrderMailEvent" e
            JOIN "OrderMail" m ON m.id = e."orderMailId"
            JOIN "Vendor" v ON v.id = m."vendorId"
            JOIN "OrderMailCandidateDecision" d ON d."eventId" = e.id AND d.decision = 'linked'
            JOIN "Purchase" p ON p.id = d."purchaseId"
            LEFT JOIN "Email" email ON email."orderMailId" = m.id
            LEFT JOIN "Run" r ON r.id = email."runId"
           WHERE v.shortcode = $1
           ORDER BY e.event`,
    params: only("vendor"),
    rows: () => [
      {
        event: "confirmation",
        actorMatches: true,
        sourceMatches: true,
        orderId: source.orderId,
      },
    ],
  },
  {
    label: "the unselected shipping Email is not admitted to a paid Run",
    sql: `SELECT count(*)::int AS count FROM "Email" email
            JOIN "OrderMail" m ON m.id = email."orderMailId"
            JOIN "Vendor" v ON v.id = m."vendorId"
            JOIN "OrderMailEvent" e ON e."orderMailId" = m.id AND e.event = 'shipped'
           WHERE v.shortcode = $1 AND email."runId" IS NOT NULL`,
    params: only("vendor"),
    rows: () => [{ count: 0 }],
  },
  {
    label: "the Purchase keeps the order date printed in the confirmation",
    sql: `SELECT p.date::text AS date FROM "Purchase" p JOIN "Vendor" v ON v.id = p."vendorId"
           WHERE v.shortcode = $1 AND p."deletedAt" IS NULL`,
    params: only("vendor"),
    rows: () => [{ date: "2026-09-10" }],
  },
  {
    label: "the new Product keeps the product link the email showed",
    sql: `SELECT DISTINCT x.url FROM "Expense" ex
            JOIN "Purchase" p ON p.id = ex."purchaseId"
            JOIN "Vendor" v ON v.id = p."vendorId"
            JOIN "EntityExternalId" x ON x."entityId" = ex."productId" AND x."deletedAt" IS NULL
           WHERE v.shortcode = $1 AND ex."deletedAt" IS NULL AND x.url IS NOT NULL`,
    params: only("vendor"),
    rows: () => [{ url: source.productUrl }],
  },
];

/** A live coordinator run: minutes of real model turns, never instant. */
const LIVE_RUN_MS = 480_000;

const vendorRun = (until: RunWait["until"]): RunWait => ({
  sql: `SELECT r.id FROM "Run" r JOIN "Email" e ON e."runId" = r.id
         WHERE e.shortcode = $1 AND r.purpose = 'mail_import'
         ORDER BY r."startedAt" DESC LIMIT 1`,
  params: only("email"),
  until,
  timeoutMs: LIVE_RUN_MS,
});

const photoRun = (until: RunWait["until"]): RunWait => ({
  sql: `SELECT id FROM "Run" WHERE shortcode = $1`,
  params: only("run"),
  until,
  timeoutMs: LIVE_RUN_MS,
});

/**
 * Journeys on the coupled harness: nothing behind the browser is scripted
 * except the synthetic sources (a saved confirmation and uploaded photos).
 * The coordinator, extraction,
 * audit, and image description call real models.
 */
const coupledJourneys: Journey[] = [
  {
    id: "import-order-mail",
    title: "import a saved order confirmation through the live agent",
    coupled: true,
    timeoutMs: 600_000,
    context:
      "A saved Email has an Import this Email action. Starting the import shows a Run link that opens the live import.",
    start: "email",
    steps: [
      {
        goal: "Select Import this Email, then open the Run link shown for the started import. Finish on the Run detail page with Live agent visible.",
        // The run page streams the coordinator's live conversation.
        check: { visible: () => ["Live agent"] },
      },
    ],
    awaitRun: vendorRun("completed"),
    visible: () => ["Purchases changed"],
    db: [
      importedOrder(LIVE_IMPORT.mail.orderId, LIVE_IMPORT.mail.cents),
      ...mailImportFollowUps(LIVE_IMPORT.mail),
      {
        label: "the Purchase belongs to the member's mail-only account",
        sql: `SELECT a.status
                FROM "Purchase" p JOIN "Vendor" v ON v.id = p."vendorId"
                JOIN "VendorAccount" a ON a.id = p."vendorAccountId"
               WHERE v.shortcode = $1 AND p."deletedAt" IS NULL`,
        params: only("vendor"),
        rows: () => [{ status: "disabled" }],
      },
    ],
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
                  JOIN "PhotoRunImage" t ON t."imageId" = j."imageId"
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
        check: { visible: () => ["Start grouping"] },
      },
      {
        goal: "Press Start grouping once. Finish when Start grouping disappears and the Progress section says the agent is preparing item groups.",
        check: {
          db: [
            {
              label: "grouping was dispatched before waiting for proposals",
              sql: `SELECT ("dispatchEventId" IS NOT NULL) AS started FROM "Run" WHERE shortcode = $1`,
              params: only("run"),
              rows: () => [{ started: true }],
            },
          ],
        },
      },
      {
        awaitRun: photoRun("awaiting_approval"),
        tapControl: { web: { role: "button", name: "Approve item" } },
        check: { visible: () => ["Approved"] },
      },
      {
        web: "Select the remaining item and approve it using batch approval.",
      },
    ],
    awaitRun: photoRun("completed"),
    visible: () => ["Review complete"],
    db: [
      {
        label: "every photo is settled on a committed item",
        sql: `SELECT t.state, count(*)::int AS photos
                FROM "PhotoRunImage" t JOIN "Run" r ON r.id = t."runId"
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
                JOIN "PhotoRunImage" t ON t."runId" = r.id
                JOIN "EntityAttachment" a
                  ON a."imageId" = t."imageId" AND a."entityId" = p.id
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
];

export const journeys: Journey[] = [
  {
    id: "email-navigation",
    title: "browse classified Email metadata without admitting an import",
    webOnly: true,
    viewport: { width: 390, height: 844 },
    start: "email",
    steps: [
      {
        goal: "Inspect this Email's sender, subject and relevance. Open the Emails list through the app navigation, find Synthetic Email navigation receipt, and reopen its detail. Leave the Email unchanged and do not start an import.",
        read: {
          instruction: "Read this Email's subject and sender from its detail.",
          schema: z.object({ subject: z.string(), sender: z.string() }),
          expected: () => ({
            subject: "Synthetic Email navigation receipt",
            sender: "receipts@example.test",
          }),
        },
      },
    ],
    visible: () => ["Synthetic Email navigation receipt"],
    db: [
      {
        label: "Email browsing preserves classification and admission state",
        sql: `SELECT classification, status, "executionPolicy", "runId"::text AS "runId", "orderMailId"::text AS "orderMailId" FROM "Email" WHERE shortcode = $1 AND "deletedAt" IS NULL`,
        params: only("email"),
        rows: () => [
          {
            classification: "related",
            status: "completed",
            executionPolicy: "classification_only",
            runId: null,
            orderMailId: null,
          },
        ],
      },
    ],
  },
  {
    id: "product-rename",
    title: "product rename persists after reopening",
    start: "product",
    steps: [
      {
        goal: `Edit this product, change its Name to "${JOURNEY_NAMES.productUpdatedName}", and save. Wait for the product detail to show the new name before you finish.`,
        ios: [
          "Open Edit Product. Leave the editor open.",
          `Change Name to "${JOURNEY_NAMES.productUpdatedName}". Leave the editor open with the new Name.`,
        ],
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        tapTestId: { ios: "editor.product.save" },
      },
      {
        goal: "Reopen this product's editor to inspect the saved Name. Leave the editor open and do not change any field.",
        read: {
          instruction:
            "Read the current value of the Name input in the open product editor.",
          schema: z.object({ name: z.string() }),
          expected: () => ({ name: JOURNEY_NAMES.productUpdatedName }),
        },
      },
      {
        goal: `Choose Cancel to close the product editor. Finish on the product detail with the heading "${JOURNEY_NAMES.productUpdatedName}" and no editor open.`,
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
        tapControl: {
          web: { role: "button", name: "Receive into inventory..." },
          ios: { role: "button", name: "Receive into Inventory" },
        },
      },
      {
        tapControl: { web: { role: "combobox", name: "Location" } },
        ios: [],
      },
      {
        tapControl: {
          web: {
            role: "option",
            name: JOURNEY_NAMES.receiveShelf,
            exact: false,
          },
        },
      },
      {
        goal: `Receive this expense into Inventory: pick the location "${JOURNEY_NAMES.receiveShelf}", set the quantity to add to 3, and confirm Receive.`,
        ios: [
          `Select Location "${JOURNEY_NAMES.receiveShelf}" and enter Quantity 3. Leave the receiving sheet open with that Location and Quantity.`,
        ],
        tapTestId: { ios: "receive.confirm" },
        web: [
          "In the open Receive dialog, enter Amount Value 3. Finish with the receiving dialog still open and that value entered.",
        ],
        tapControl: { web: { role: "button", name: "Add to inventory" } },
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
        goal: `Use the "Add to inventory" action on this product: search the location field for "${JOURNEY_NAMES.inventoryShelf}" and select the matching location, set the amount to 4, and submit. Finish when the product Stocked at section shows an inventory entry at "${JOURNEY_NAMES.inventoryShelf}" with amount 4.`,
        ios: `Open More and select Add to inventory. Select Location "${JOURNEY_NAMES.inventoryShelf}" and set Amount to 4. Leave the action sheet open with the selected Location and Amount 4.`,
        tapTestId: { ios: "heroAction.submit" },
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
        ios: [
          "Open More and select Record sale. Finish on the Record Sale or Disposal editor.",
          'Set Name to "Synthetic chair sale". Leave the expense editor open with that Name.',
        ],
        tapControl: {
          ios: { role: "button", name: "Done" },
          web: { role: "combobox", name: "Trade" },
        },
        web: [
          'Open Record sale and enter Name "Synthetic chair sale" and Cost -12.50. Leave the dialog open.',
        ],
      },
      {
        tapControl: {
          ios: {
            role: "textbox",
            name: "Cost",
            within: { testId: "editor.expense" },
          },
        },
      },
      {
        ios: [
          "Set Cost to -12.50. Leave the expense editor open with that Cost.",
        ],
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: [
          "Scroll down in the expense form until the Trade selector is visible. Leave the expense editor open.",
        ],
        web: [
          'Choose "Appliances & Furniture" from the open trade options. Finish with the dialog open and Trade showing Appliances & Furniture.',
          "Set Date to October 10, 2026. Finish with that Date entered and the dialog still open.",
        ],
        tapControl: {
          web: { role: "button", name: "Create" },
          ios: { role: "button", name: "Trade, None" },
        },
      },
      // Each SDK gesture stays within a visible row; five short strokes reveal the lower choices.
      ...Array.from({ length: 5 }, (): JourneyStep => ({
        tapControl: {
          ios: {
            role: "button",
            name: "Flooring",
            swipe: { direction: "down", momentum: "fast" },
          },
        },
      })),
      {
        ios: [
          'Select "Appliances & Furniture" from the open Trade menu. Leave the expense editor open with that Trade selected.',
        ],
        tapTestId: { ios: "editor.expense.save" },
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
        ios: "Open More and choose Set status. Leave the action sheet open without selecting a status.",
        tapControl: { ios: { role: "button", name: "In progress" } },
      },
      { tapTestId: { ios: "heroAction.submit" } },
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
        ios: "Open More and select Delete. Stop on the action sheet showing the impact preview. Leave the sheet open without confirming.",
        check: {
          visible: () => [
            "sub-tasks",
            "live subtasks are soft-deleted alongside it",
          ],
          db: [
            {
              label: "preview writes nothing",
              sql: `SELECT count(*)::int AS live FROM "Task" WHERE shortcode IN ($1, $2) AND "deletedAt" IS NULL`,
              params: (ids) => [ids.get("task"), ids.get("child")],
              rows: () => [{ live: 2 }],
            },
          ],
        },
      },
      {
        tapTestId: { ios: "heroAction.submit" },
        tapControl: {
          web: {
            role: "button",
            name: "Delete",
            within: { role: "dialog", name: "Delete 1 Task?" },
          },
        },
      },
      {
        tapControl: {
          ios: {
            role: "button",
            name: "Delete",
            within: { role: "group", name: "Delete Synthetic doomed task?" },
          },
        },
      },
    ],
    visible: () => [],
    db: [
      {
        label: "task soft-deleted",
        sql: `SELECT ("deletedAt" IS NOT NULL) AS deleted FROM "Task" WHERE shortcode = $1`,
        params: only("task"),
        rows: () => [{ deleted: true }],
      },
      {
        label: "declared child cascade preserves the project",
        sql: `SELECT (t."deletedAt" IS NOT NULL) AS "childDeleted", (p."deletedAt" IS NULL) AS "projectPreserved"
              FROM "Task" t CROSS JOIN "Project" p WHERE t.shortcode = $1 AND p.shortcode = $2`,
        params: (ids) => [ids.get("child"), ids.get("project")],
        rows: () => [{ childDeleted: true, projectPreserved: true }],
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
        ios: [
          "Open Edit Product. Leave the editor open.",
          'Type "synthetic-new-tag" into Add tag and press Return to add it. Leave the editor open with the new tag and existing tags.',
        ],
        tapTestId: { ios: "editor.product.save" },
        web: [
          'Open Edit Product. In the Tags section, type "synthetic-new-tag" into the textbox with placeholder "e.g. grinder-4.5in, M18" and press Enter. Leave Collections unchanged. Finish with synthetic-new-tag and synthetic-old-tag chips in Tags and the editor still open.',
          "Save changes. Finish with the editor closed.",
        ],
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
        ios: ["Open Edit Account. Leave the editor open."],
        tapTestId: { ios: "editor.financialAccount.sourceAliases.add" },
      },
      {
        ios: [
          'Set Source to "synthetic-bank". Leave the editor open with that Source value.',
        ],
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: [
          'Set the source alias Alias to "SYN CHK 1234", leaving External account id blank. Leave the editor open with that Alias.',
        ],
        tapTestId: { ios: "editor.financialAccount.save" },
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
        ios: [
          'Change the source claim Description to "Synthetic claim evidence revised", leave the editor open with the revised Description.',
        ],
        tapTestId: { ios: "editor.expense.save" },
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
        ios: "Change Kcal from 120 to 150. Leave the editor open with Kcal 150.",
        tapTestId: { ios: "editor.product.save" },
        web: [
          "Open Edit Product, open Nutrition and set Calories (kcal) to 150. Finish with the editor open and that field showing 150.",
          "Save changes. Finish when the editor closes and Edit Product is visible again.",
        ],
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
        goal: 'Edit this product and add an external ID row. Finish with its Source field showing "synthetic-shop" and the editor still open.',
        ios: 'Enter Source "synthetic-shop" and tap Done to dismiss the keyboard. Finish with Source showing "synthetic-shop" and the editor still open.',
      },
      {
        goal: 'Set Kind "ASIN" and Identifier "B0SYNTH001". Keep the editor open.',
        web: [
          'Type "asin" into the Kind search field. Finish with the matching options open.',
          'Choose the "asin" option and enter Identifier "B0SYNTH001". Finish with Identifier showing "B0SYNTH001" and the editor still open.',
        ],
        ios: 'Enter External id "B0SYNTH001" and tap Done to dismiss the keyboard. Finish with External id showing "B0SYNTH001" and the editor still open.',
      },
      {
        goal: 'Save this product. Finish with the Edit action visible and the product detail showing external ID "B0SYNTH001" from Source "synthetic-shop" with Kind "asin".',
        ios: [],
        tapTestId: { ios: "editor.product.save" },
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
        ios: 'Enter Source "synthetic-bank". Leave the editor open with that Source.',
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: 'Enter External id "SYN-REF-1". Leave the editor open with that External id.',
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        tapTestId: { ios: "editor.financialTransaction.save" },
      },
      {
        ios: 'Scroll down on the transaction detail until source ref "SYN-REF-1" is visible. Leave the detail open.',
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
    id: "run-console",
    title: "run console shows progress and resolves a finding",
    start: "run",
    steps: [
      {
        goal: "Read the run's live progress, then dismiss the finding that says it is a synthetic finding to resolve.",
        ios: [
          "Scroll down to the run progress. Finish with Reading synthetic orders and Synthetic order 7 visible.",
        ],
        check: {
          visible: () => ["Reading synthetic orders", "Synthetic order 7"],
        },
      },
      {
        ios: "Scroll down until Prepared orders is visible below Findings and Synthetic finding to resolve. Leave the finding open.",
        tapControl: {
          ios: {
            role: "button",
            name: "Dismiss",
            within: { testId: "run.console" },
          },
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
        ios: "Set Amount to 300.",
        tapTestId: { ios: "editor.recipe.save" },
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
        ios: [],
        tapTestId: { ios: "section.splitExpense" },
        tapControl: { web: { role: "button", name: "Split..." } },
      },
      {
        goal: 'Split this expense into two parts: "Synthetic part one" costing 6.00 and "Synthetic part two" costing 4.00, then confirm. If the app does not allow it because the parts do not add up to the original cost, stop there.',
        web: [
          'In the open Split dialog, set Part 1 name to "Synthetic part one" and Part 1 cost to 6.00. Leave the dialog open.',
          'Set Part 2 name to "Synthetic part two" and Part 2 cost to 4.00. Finish with those values in the fields and the dialog still open.',
        ],
        ios: 'Set Part 1 name to "Synthetic part one". Leave the Split sheet open with that Name.',
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: "Set Part 1 cost to 6.00. Leave the Split sheet open with that Cost.",
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: [],
        tapControl: {
          ios: {
            role: "textbox",
            name: "Part 2 name",
            within: { testId: "split.form" },
          },
        },
      },
      {
        ios: 'Set the focused Part 2 name to "Synthetic part two". Leave the Split sheet open with that Name.',
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: "Set Part 2 cost to 4.00. Leave the Split sheet open with that Cost.",
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        ios: [],
        check: {
          visible: () => ["add up to the original cost exactly"],
          disabledButtons: { web: ["Split into 2"], ios: ["Split into 2"] },
          db: [purchaseParts(1, 1001)],
        },
      },
      {
        ios: [],
        tapControl: {
          ios: {
            role: "textbox",
            name: "Part 2 cost",
            scrollDirection: "up",
            within: { testId: "split.form" },
          },
        },
      },
      {
        goal: "Fix the split so the two parts add up exactly: part two costs 4.01. Confirm the split.",
        web: "Set Part 2 cost to 4.01. Finish with that value entered and the Split dialog still open.",
        ios: "Set Part 2 cost to 4.01. Leave the Split sheet open with that value entered.",
        tapControl: { ios: { role: "button", name: "Done" } },
      },
      {
        tapTestId: { ios: "split.save" },
        tapControl: { web: { role: "button", name: "Split into 2" } },
      },
      {
        tapControl: {
          ios: {
            role: "button",
            name: "Split",
            within: { role: "group", name: "Split this expense?" },
          },
        },
      },
    ],
    visible: () => [],
    db: [
      purchaseParts(2, 1001),
      {
        // The sum alone accepts any pair that conserves it (5.00 + 5.01).
        label: "each part keeps the cents the member entered",
        sql: `SELECT e.name, round(e.cost * 100)::int AS cents
              FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId"
              WHERE p.shortcode = $1 AND e."deletedAt" IS NULL
              ORDER BY e.cost DESC`,
        params: only("purchase"),
        rows: () => [
          { name: "Synthetic part one", cents: 600 },
          { name: "Synthetic part two", cents: 401 },
        ],
      },
    ],
  },
  {
    id: "finance-split-unknown-cost",
    title: "splitting an expense with unknown cost is refused",
    start: "expense",
    steps: [
      {
        goal: "Try to split this expense into two parts without entering any costs, and confirm the split. Stop when the app refuses.",
        web: [],
        ios: [],
        tapTestId: { ios: "section.splitExpense" },
        tapControl: { web: { role: "button", name: "Split..." } },
        check: {
          disabledButtons: { web: ["Split into 2"], ios: ["Split into 2"] },
        },
      },
      {
        ios: [],
      },
    ],
    visible: () => ["enter a cost"],
    db: [
      purchaseParts(1, 0),
      {
        label: "refusal preserves the original unknown cost",
        sql: `SELECT cost FROM "Expense" WHERE shortcode = $1 AND "deletedAt" IS NULL`,
        params: only("expense"),
        rows: () => [{ cost: null }],
      },
    ],
  },
  {
    id: "finance-attach-expenses",
    title:
      "attach an expense from another purchase after the move confirmation",
    start: "purchase",
    steps: [
      {
        ios: "Scroll down through this purchase detail until Attach existing expenses is visible in its report. Leave that button visible on the detail page.",
        tapTestId: { ios: "section.linkExpenses" },
        tapControl: {
          web: { role: "button", name: "Attach existing expenses" },
        },
      },
      {
        goal: 'Attach existing expenses to this purchase: select "Synthetic movable expense", wait for the Attach button to become enabled, and press it once. The app then warns that the expense moves off another purchase; stop there and do not press the confirming button.',
        web: [
          "In the open Attach expenses dialog, select the checkbox for Synthetic movable expense. Finish with that row selected and the dialog still open.",
        ],
        ios: "In the open Attach expenses sheet, select only Synthetic movable expense. Finish with that row selected and Attach 1 available.",
        tapTestId: { ios: "attach.expenses.save" },
        tapControl: { web: { role: "button", name: "Attach 1" } },
        check: { db: [expensePurchase("otherPurchase")] },
      },
      {
        goal: "Confirm the move: press the confirming Attach button.",
        web: [],
        ios: [],
        tapControl: {
          web: { role: "button", name: "Confirm: attach 1" },
          ios: { role: "button", name: "Attach" },
        },
      },
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
        ios: [],
        tapTestId: { ios: "section.linkProducts" },
        tapControl: { web: { role: "button", name: "Attach products" } },
      },
      {
        goal: 'Attach products to this purchase: choose "Synthetic Attachable Sieve" and attach it.',
        web: [
          "In the open Attach products dialog, select only the checkbox for Synthetic Attachable Sieve. Finish with exactly 1 selected, Attach 1 available, and the dialog still open.",
        ],
        ios: "In the open Attach products sheet, select only Synthetic Attachable Sieve. Finish with that row selected and Attach 1 available.",
        tapTestId: { ios: "attach.products.save" },
        tapControl: { web: { role: "button", name: "Attach 1" } },
      },
      {
        ios: "Scroll down past Financial settlement to the Products section on this purchase detail. Expand Products if collapsed. Finish with Synthetic Attachable Sieve visible in Products and the detail still open.",
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
        ios: "Open the Library tab, then Browse catalog. Finish on the Browse catalog list.",
        tapControl: {
          ios: {
            role: "button",
            name: "Tasks",
            exact: false,
            within: { testId: "browse.catalog" },
          },
        },
      },
      {
        tapControl: { ios: { role: "button", name: "List controls" } },
      },
      {
        tapControl: { ios: { role: "button", name: "View" } },
      },
      {
        tapControl: { ios: { role: "button", name: "Board" } },
        check: {
          visible: () => ["Inbox", JOURNEY_NAMES.boardProjectA],
        },
      },
      {
        goal: `Move the card "Synthetic inbox card" from Inbox into the "${JOURNEY_NAMES.boardProjectA}" lane.`,
        web: `Drag the "Drag Synthetic inbox card" handle onto the "${JOURNEY_NAMES.boardProjectA} task drop target". Finish with Synthetic inbox card inside that project column and Inbox empty.`,
        ios: [],
        tapControl: {
          ios: { role: "button", name: "Move Synthetic inbox card" },
        },
      },
      {
        tapControl: {
          ios: { role: "button", name: `Lane: ${JOURNEY_NAMES.boardProjectA}` },
        },
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
