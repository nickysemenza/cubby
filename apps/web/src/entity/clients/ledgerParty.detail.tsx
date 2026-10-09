import { WardrobeAction, WardrobeLink } from "~/app/collections/wardrobe-link";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const ledgerPartyDetailHooks = defineDetailHooks("ledgerParty", {
  slots: {
    wardrobe: {
      component: WardrobeLink,
      applies: (record) => record.kind === "member" || record.kind === "guest",
    },
  },
  headerActions: WardrobeAction,
});
