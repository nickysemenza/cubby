import {
  wishCreateInput,
  wishFilterFields,
  wishListOut,
  wishOut,
  wishUpdateData,
} from "@cubby/schemas/wish";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineSlim, registerEntityCrudToolset } from "./_shared";

const slimWish = defineSlim(wishOut, (row) => wishOut.parse(row));

/** Wishlist tools deliberately model alternatives as a single “pick one” set. */
export function registerWishTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "wish",
    entityPlural: "wishes",
    createInput: wishCreateInput.shape,
    updateShape: wishUpdateData.shape,
    filterFields: wishFilterFields,
    mcpListOut: wishListOut,
    out: wishOut,
    slim: slimWish,
    sort: { orderBy: "createdAt", direction: "desc" },
    descriptions: {
      list: "List wishlist items. Filter by acquired state, a candidate Tool product, or a name/notes search. Each item is one desired outcome with zero or more alternatives to pick from.",
      get: "Get a wishlist item, including its candidate Tool products.",
      create:
        "Create a wishlist item. candidateProductIds are optional Tool product shortcodes and represent alternatives, not items that all need to be bought.",
      update:
        "Update a wishlist item, replace its candidate Tool alternatives, or mark it acquired. Marking acquired does not create inventory or an expense.",
      delete: "Soft-delete wishlist items by ID.",
    },
  });
}
