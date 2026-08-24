/**
 * The server-side binding table: which Zod contract each shortcode entity's
 * public surface is actually built from.
 *
 * THE CONTRACT: adding an entity to `ShortcodeEntity` (i.e. to `entityManifest`)
 * must produce ONE compile error, here, listing everything the new entity has
 * not supplied. The `satisfies Record<ShortcodeEntity, EntityBinding>` clause
 * below is what enforces that — the same device as `ENTITY_NOT_FOUND_REASON`
 * (schemas/identifiers.ts) and `DISPLAY_NAME_COLUMN` (repo/shortcode-resolver.ts).
 * A `null` slot is therefore a DECISION, not an omission: it says "this entity
 * genuinely has no such surface", and each one carries the reason inline.
 *
 * Why this is not in `entityManifest`: the manifest is pure, layer-shared DATA
 * (`packages/schemas`, no server imports, no runtime values beyond strings and
 * booleans) — it can say an entity is creatable over MCP, but it cannot hold
 * the `z.ZodType` that create is checked against. This file is the server-side
 * half: the manifest DECLARES, this BINDS. The boundary is the same one the
 * manifest's own header draws.
 *
 * Why the binding stops at schemas. Two axes that look like they belong here
 * deliberately do not:
 *
 * - **Repo reader/writer functions.** Binding them would make this module
 *   import all eighteen repo modules, and every router that reads one binding
 *   would then pull in every repo — plus the services each repo pulls behind
 *   it. The routers already import exactly the repo functions they call, and
 *   the factory (`api/crud-factory.ts`) already derives the one reader that was
 *   duplicated nine times (`getByID` from `getByShortcode`). There is nothing
 *   left for a registry of functions to remove.
 *
 * - **Filter-option specs.** Dropdown rosters are NOT one-per-entity:
 *   `ingredientWithProduct`, `locationWithInventory` and `locationIdentityProduct`
 *   are three rosters over two entities, and the last one is a *product* roster
 *   reached through location. Keying them by entity would misrepresent them, so
 *   they keep their own spine — `FILTER_OPTION_SPECS`, a
 *   `satisfies Record<FilterOptionKind, …>` in `repo/filter-options.ts`, keyed
 *   by the axis that actually has one entry per member.
 */

import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  financialAccountCreateInput,
  financialAccountOut,
  financialAccountUpdateData,
} from "@cubby/schemas/financial-account";
import {
  financialTransactionCreateInput,
  financialTransactionOut,
  financialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import {
  ingredientCreateInput,
  ingredientMcpOut,
  ingredientOut,
  ingredientUpdateData,
} from "@cubby/schemas/ingredient";
import {
  inventoryCreatePayloadData,
  inventoryEntryOut,
  inventoryMcpOut,
  inventoryUpdatePayloadData,
} from "@cubby/schemas/inventory";
import {
  ledgerPartyCreateInput,
  ledgerPartyOut,
  ledgerPartyUpdateData,
} from "@cubby/schemas/ledger-party";
import {
  ledgerTransferCreateInput,
  ledgerTransferOut,
  ledgerTransferUpdateData,
} from "@cubby/schemas/ledger-transfer";
import {
  locationCreateInput,
  locationMcpOut,
  locationOut,
  locationUpdateData,
} from "@cubby/schemas/location";
import {
  mealCreateInput,
  mealMcpOut,
  mealOut,
  mealUpdateData,
} from "@cubby/schemas/meal";
import {
  productCreateInput,
  productMcpOut,
  productTopLevelOut,
  productUpdateData,
} from "@cubby/schemas/product";
import {
  expenseCreateInput,
  expenseOut,
  expenseUpdateData,
  projectCreateInput,
  projectOut,
  projectUpdateData,
  taskCreateInput,
  taskOut,
  taskUpdateData,
} from "@cubby/schemas/project";
import {
  purchaseCreateInput,
  purchaseOut,
  purchaseUpdateData,
} from "@cubby/schemas/purchase";
import {
  recipeCreateInput,
  recipeMcpOut,
  recipeOut,
  recipeUpdateData,
} from "@cubby/schemas/recipe";
import {
  vendorCreateInput,
  vendorOut,
  vendorUpdateData,
} from "@cubby/schemas/vendor";
import { wishCreateInput, wishOut, wishUpdateData } from "@cubby/schemas/wish";
import type { ZodSchema } from "zod";

/**
 * One entity's CRUD contract, keyed to match the `schemas` bag the procedure
 * factories take — a router spreads it (`...ENTITY_BINDINGS.vendor.crud`) and
 * adds only what is genuinely its own (`filters`, `sort`, output overrides).
 */
type CrudBinding = {
  /** The public id: always the entity's own shortcode schema. */
  idSchema: ZodSchema;
  createInput: ZodSchema;
  updateInput: ZodSchema;
  output: ZodSchema;
};

type EntityBinding = {
  /** `null` for an entity with no first-class create/update surface. */
  crud: CrudBinding | null;
  /** The slim projection MCP serves; `null` where MCP serves the full shape. */
  mcpOut: ZodSchema | null;
};

/**
 * Pair an entity with its three write/read schemas, filling in `idSchema` from
 * the entity itself — the one slot that is derivable rather than declared.
 *
 * Generic over `S` (not annotated `Omit<CrudBinding, "idSchema">`) so each
 * entry keeps its CONCRETE schema types. The procedure factories parameterize
 * over the schema, not its output type, precisely so `z.infer<SCreate>` is the
 * repository callback's stated contract; widening to `ZodSchema` here would
 * erase that at every router that spreads a binding.
 */
const crud = <
  E extends ShortcodeEntity,
  S extends Omit<CrudBinding, "idSchema">,
>(
  entity: E,
  schemas: S,
) => ({ idSchema: shortcodeSchema(entity), ...schemas });

export const ENTITY_BINDINGS = {
  // Import-only: a cookbook is minted by the EPUB/URL importer, never by a
  // create form, so there is no create/update/out trio to bind.
  cookbook: { crud: null, mcpOut: null },

  expense: {
    crud: crud("expense", {
      createInput: expenseCreateInput,
      updateInput: expenseUpdateData,
      output: expenseOut,
    }),
    mcpOut: null,
  },

  financialAccount: {
    crud: crud("financialAccount", {
      createInput: financialAccountCreateInput,
      updateInput: financialAccountUpdateData,
      output: financialAccountOut,
    }),
    mcpOut: null,
  },

  financialTransaction: {
    crud: crud("financialTransaction", {
      createInput: financialTransactionCreateInput,
      updateInput: financialTransactionUpdateData,
      output: financialTransactionOut,
    }),
    mcpOut: null,
  },

  // An image row is minted by an UPLOAD, not by a create payload — the bytes
  // and the R2 key are the input, and there is no shape a client could post.
  image: { crud: null, mcpOut: null },

  ingredient: {
    crud: crud("ingredient", {
      createInput: ingredientCreateInput,
      updateInput: ingredientUpdateData,
      output: ingredientOut,
    }),
    mcpOut: ingredientMcpOut,
  },

  inventory: {
    crud: crud("inventory", {
      createInput: inventoryCreatePayloadData,
      updateInput: inventoryUpdatePayloadData,
      output: inventoryEntryOut,
    }),
    mcpOut: inventoryMcpOut,
  },

  ledgerParty: {
    crud: crud("ledgerParty", {
      createInput: ledgerPartyCreateInput,
      updateInput: ledgerPartyUpdateData,
      output: ledgerPartyOut,
    }),
    mcpOut: null,
  },

  ledgerTransfer: {
    crud: crud("ledgerTransfer", {
      createInput: ledgerTransferCreateInput,
      updateInput: ledgerTransferUpdateData,
      output: ledgerTransferOut,
    }),
    mcpOut: null,
  },

  location: {
    crud: crud("location", {
      createInput: locationCreateInput,
      updateInput: locationUpdateData,
      output: locationOut,
    }),
    mcpOut: locationMcpOut,
  },

  meal: {
    crud: crud("meal", {
      createInput: mealCreateInput,
      updateInput: mealUpdateData,
      output: mealOut,
    }),
    mcpOut: mealMcpOut,
  },

  product: {
    crud: crud("product", {
      createInput: productCreateInput,
      updateInput: productUpdateData,
      // The plain product shape. Detail/create/update are USDA- and
      // usage-enriched supersets (`productWithFoodOut`), declared by the router
      // that serves them rather than here.
      output: productTopLevelOut,
    }),
    mcpOut: productMcpOut,
  },

  project: {
    crud: crud("project", {
      createInput: projectCreateInput,
      updateInput: projectUpdateData,
      output: projectOut,
    }),
    mcpOut: null,
  },

  purchase: {
    crud: crud("purchase", {
      createInput: purchaseCreateInput,
      updateInput: purchaseUpdateData,
      output: purchaseOut,
    }),
    mcpOut: null,
  },

  recipe: {
    crud: crud("recipe", {
      createInput: recipeCreateInput,
      updateInput: recipeUpdateData,
      output: recipeOut,
    }),
    mcpOut: recipeMcpOut,
  },

  task: {
    crud: crud("task", {
      createInput: taskCreateInput,
      updateInput: taskUpdateData,
      output: taskOut,
    }),
    mcpOut: null,
  },

  vendor: {
    crud: crud("vendor", {
      createInput: vendorCreateInput,
      updateInput: vendorUpdateData,
      output: vendorOut,
    }),
    mcpOut: null,
  },

  wish: {
    crud: crud("wish", {
      createInput: wishCreateInput,
      updateInput: wishUpdateData,
      output: wishOut,
    }),
    mcpOut: null,
  },
} satisfies Record<ShortcodeEntity, EntityBinding>;
