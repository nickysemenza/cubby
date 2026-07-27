import inventoryAuditDoc from "../../../../../../docs/inventory-audit.md?raw";
import { GuideDoc } from "../_components/GuideDoc";

/**
 * The inventory-audit guide, wrapped so the registry can `lazy()` it.
 *
 * Both halves need to stay behind that boundary: `GuideDoc` pulls
 * react-markdown + remark-gfm (~150 KiB), and the `?raw` import inlines the
 * whole markdown source. The docs routes reference the registry from
 * `beforeLoad`, which lives in the eager route chunk — so importing either one
 * directly from the registry puts them on the critical path of every page.
 */
export function InventoryAuditGuide() {
  return <GuideDoc>{inventoryAuditDoc}</GuideDoc>;
}
