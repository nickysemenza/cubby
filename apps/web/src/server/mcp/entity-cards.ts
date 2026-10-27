import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityPreviewFieldKeys } from "@cubby/schemas/entity-preview";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import {
  entityCardsInput,
  entityCardsOutput,
} from "~/contracts/entity-preview";
import { readDisplayReferenceField } from "~/entity/entity-references";
import { generatedBrowserRoutes } from "~/entity/generated/entity-routes.gen";
import { readPathValue } from "~/entity/read-path";
import { APP_ORIGIN } from "~/lib/auth-constants";
import { formatCurrency } from "~/lib/number-format";
import { getAppOrigin } from "~/server/cf-env";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { entityMcpGetCommandSchema } from "~/server/entity-kernel/contracts";

import type { McpEntityExecutor } from "./kernel-actions";

const recordResult = z.object({
  item: z.looseObject({}).nullable(),
});
const scalar = z.union([z.string(), z.number(), z.boolean()]);
type Card = z.infer<typeof entityCardsOutput>["items"][number];
type AvailableCard = Extract<Card, { status: "available" }>;

/** A bounded, read-only projection of the same fields used by hover previews. */
export async function readEntityCards(
  context: EntityKernelContext,
  input: z.infer<typeof entityCardsInput>,
  execute: McpEntityExecutor,
): Promise<z.infer<typeof entityCardsOutput>> {
  const items: Card[] = [];
  // Read each identity once, but retain caller order and repeated positions.
  const reads = new Map<string, Card>();
  for (const requested of input.shortcodes) {
    const parsed = parseShortcode(requested);
    if (!parsed) {
      // Admission and entity inference share the canonical shortcode registry.
      throw new Error("Validated shortcode has no entity type");
    }
    const { type: entity, shortcode } = parsed;
    const cached = reads.get(shortcode);
    if (cached) {
      items.push(cached);
      continue;
    }
    const command = entityMcpGetCommandSchema.safeParse({
      action: "get",
      entity,
      id: shortcode,
      missing: "null",
    });
    if (!command.success) {
      items.push({
        status: "unavailable",
        shortcode,
        reason: "unsupported_entity",
      });
      continue;
    }
    const { item } = recordResult.parse(
      await execute(context, command.data, "full"),
    );
    if (!item) {
      const absent = {
        status: "unavailable",
        shortcode,
        reason: "not_found",
      } satisfies Card;
      reads.set(shortcode, absent);
      items.push(absent);
      continue;
    }
    const summary = entitySummary[command.data.entity];
    const fields = entityFieldModels[command.data.entity].fields;
    const facts: AvailableCard["facts"] = [];
    for (const key of entityPreviewFieldKeys(command.data.entity)) {
      if (facts.length === 8) break;
      const field = fields.find((candidate) => candidate.key === key);
      if (!field) continue;
      const reference = readDisplayReferenceField(item, field);
      if (reference) {
        const names = reference.items.flatMap((ref) =>
          ref.name ? [ref.name] : [],
        );
        if (names.length)
          facts.push({ label: field.label, value: names.join(", ") });
        continue;
      }
      // Custom structured renderers are not scalar facts. Never expose their
      // raw objects, internal ids, or guessed summaries in the chat widget.
      if (
        field.kind === "identifier" ||
        field.kind === "json" ||
        field.kind === "dateRange"
      )
        continue;
      const raw = readPathValue(
        item,
        field.display.readPath ?? field.readKey ?? field.key,
      );
      const value = scalar.safeParse(raw);
      if (!value.success || value.data === "") continue;
      const option = (
        field.control?.options ??
        field.display.valueOptions ??
        []
      ).find((candidate) => candidate.value === value.data);
      const text =
        option?.label ??
        (typeof value.data === "number" &&
        (field.display.format === "currency" ||
          field.display.format === "signedCurrency")
          ? formatCurrency(value.data)
          : typeof value.data === "boolean"
            ? value.data
              ? "Yes"
              : "No"
            : String(value.data));
      facts.push({ label: field.label, value: text });
    }
    const title = z
      .string()
      .nullish()
      .parse(readPathValue(item, summary.titleField));
    const route = Object.entries(generatedBrowserRoutes).find(
      ([key]) => key === entity,
    )?.[1];
    const images = z
      .array(z.object({ url: z.string() }))
      .nullish()
      .parse(readPathValue(item, "displayImages"));
    const card: AvailableCard = {
      status: "available",
      shortcode,
      name: title || shortcode,
      entityLabel: summary.singular,
      href: route
        ? new URL(
            route.routes.detail.replace(
              "$shortcode",
              encodeURIComponent(shortcode),
            ),
            getAppOrigin() ?? APP_ORIGIN,
          ).href
        : null,
      imageUrl: images?.[0]?.url ?? null,
      facts,
    };
    reads.set(shortcode, card);
    items.push(card);
  }
  return entityCardsOutput.parse({ items });
}
