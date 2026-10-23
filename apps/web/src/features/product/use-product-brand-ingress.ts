import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import { useAllEntityRecords } from "~/entity/hooks/use-all-entity-records";

/** Resolve an accepted external brand claim before writing a Product reference. */
export function useProductBrandIngress() {
  const roster = useAllEntityRecords("vendor");
  const commands = useEntityCommands("vendor");
  const resolve = async (raw: string | null | undefined) => {
    const name = raw?.trim();
    if (!name || name.toLowerCase() === "(unspecified)") return null;
    if (roster.isLoading)
      throw new Error("Brands are still loading; try again.");
    if (roster.error) throw roster.error;
    const key = ["generic", "unbranded", "generic / unbranded"].includes(
      name.toLowerCase(),
    )
      ? "generic / unbranded"
      : name.toLowerCase();
    const matches = roster.records.filter((row) =>
      [row.name, ...row.aliases].some(
        (value) => value.trim().toLowerCase() === key,
      ),
    );
    if (matches.length > 1)
      throw new Error(
        `Brand name "${name}" is ambiguous; select its Vendor reference.`,
      );
    if (matches[0]) return parseShortcodeFor("vendor", matches[0].id);
    const result = await commands.create({
      intent: "capture",
      values: { name },
      surface: "quick-create",
    });
    if (!result.ok || !result.result)
      throw new Error(
        result.ok
          ? "Brand creation returned no record."
          : (result.issues[0]?.message ?? "Brand creation failed."),
      );
    return parseShortcodeFor("vendor", result.result.id);
  };
  return { resolve, records: roster.records };
}
