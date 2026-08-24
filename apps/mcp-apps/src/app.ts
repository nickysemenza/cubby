import { readCubbyAppId } from "./origin";
import { isMcpAppId } from "./metadata";
import { bootstrapShoppingList } from "./shopping-list";
import { bootstrapUsdaPicker } from "./usda-picker";

const bootstraps = {
  "shopping-list": bootstrapShoppingList,
  "usda-picker": bootstrapUsdaPicker,
} as const;

const appId = readCubbyAppId(document);
const bootstrap = appId && isMcpAppId(appId) ? bootstraps[appId] : undefined;

if (bootstrap) {
  void bootstrap();
} else {
  document
    .getElementById("root")
    ?.replaceChildren("Could not determine which Cubby app to render.");
}
