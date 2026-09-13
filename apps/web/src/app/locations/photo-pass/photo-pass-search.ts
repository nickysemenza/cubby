import { locationShortcode } from "@cubby/schemas/identifiers";
import { locationType } from "@cubby/schemas/location";
import { z } from "zod";

/**
 * Shared leaf module: the route validates search with this schema, and the
 * lazy-loaded `PhotoPassWorkbench` consumes the same inferred type, without
 * either one importing the other and creating a cycle.
 */
export const photoPassSearchSchema = z.object({
  /** Scope the walk to this location's descendants. */
  parent: locationShortcode.optional().catch(undefined),
  /** `house` = the whole missing-photo backlog; `scan` = QR-driven, no queue. */
  scope: z.enum(["house", "scan"]).optional().catch(undefined),
  /** Include locations that already have a photo — a deliberate re-shoot. */
  all: z.boolean().optional().catch(undefined),
  type: z.array(locationType).optional().catch(undefined),
});
export type PhotoPassSearch = z.infer<typeof photoPassSearchSchema>;
