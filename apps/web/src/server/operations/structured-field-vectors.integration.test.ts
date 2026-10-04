import { structuredValueSchemas } from "@cubby/schemas/structured-value-schemas";
import { testUserId } from "@cubby/schemas/testing";
import vectorFile from "@cubby/shared/golden-vectors/structured-roundtrip.json";
import { buildEntity } from "tooling/factories/build";
import { stabilize, wireJson } from "tooling/stabilize-vector";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { project, wireValue } from "~/entity/editing/structured-value";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

const vectorSchema = z.object({
  entity: z.string(),
  field: z.string(),
  read: z.json(),
  input: z.json(),
});
const vectors = z.array(vectorSchema).parse(vectorFile.vectors);

const evidence = {
  amount: 10,
  occurredOn: "2026-08-20",
  description: "Synthetic claim evidence",
  context: null,
  disambiguator: null,
};
const claim = {
  source: "synthetic-provider",
  providerId: "synthetic-row-1",
  normalizedEvidence: evidence,
  reconciliation: { decision: "amounts_match" },
};

/**
 * The 'read -> input' vector for every structured field is a payload the server really reads, not
 * one typed by hand: each case writes a synthetic record through the kernel, reads it back, and
 * the stabilized read must equal the vector's `read`, and the generic editor's projection of it
 * (`project` then `wireValue`, over the generated `valueSchema`) must equal the vector's `input`,
 * which the unit test proves the field's own input schema accepts. A change to a read shape
 * therefore cannot leave a vector stale, and a field cannot ship an editor that sends back
 * something other than what it read. (recipe.sections has its own test.)
 */
describe("structured field read-to-input vectors", () => {
  const ctx = withTestDb();

  const kernel = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );

  // oxlint-disable-next-line anti-slop/no-object-parameters -- each case passes a different entity's create input; it is serialized to wire JSON at once.
  const create = async (entity: string, data: object) => {
    const created = await executeEntity(kernel(), {
      action: "create",
      entity: z
        .enum([
          "recipe",
          "meal",
          "vendor",
          "financialAccount",
          "expense",
          "ledgerTransfer",
          "ledgerParty",
        ])
        .parse(entity),
      data: z.json().parse(wireJson(data)),
    });
    if (created.action !== "create") throw new Error("unreachable");
    return z.object({ id: z.string() }).loose().parse(created.item).id;
  };

  const read = async (entity: string, id: string) => {
    const got = await executeEntity(kernel(), {
      action: "get",
      entity: z
        .enum([
          "recipe",
          "meal",
          "vendor",
          "financialAccount",
          "expense",
          "ledgerTransfer",
        ])
        .parse(entity),
      id,
      missing: "error",
    });
    if (got.action !== "get") throw new Error("unreachable");
    return z.record(z.string(), z.json()).parse(wireJson(got.item));
  };

  /** Each case writes one synthetic record and returns the id to read the field from. */
  const records = {
    "recipe.meta": () =>
      create("recipe", {
        ...buildEntity("recipe", { name: "Vector loaf", sections: [] }),
        meta: {
          url: "https://example.test/vector-loaf",
          times: { total: "1 hr 10 min", totalMinutes: 70 },
          equipment: ["Dutch oven"],
          page: "12",
        },
      }),
    "recipe.yield": () =>
      create("recipe", {
        ...buildEntity("recipe", { name: "Vector cookies", sections: [] }),
        yield: { value: 24, unit: "cookies", upperValue: 30 },
      }),
    "meal.recipes": async () => {
      const recipeId = await create(
        "recipe",
        buildEntity("recipe", { name: "Vector stew", sections: [] }),
      );
      return create("meal", {
        ...buildEntity("meal", { name: "Vector supper" }),
        recipes: [{ recipeId, scale: 2, sortOrder: 1 }],
      });
    },
    "financialAccount.identity": () =>
      create("financialAccount", {
        name: "Vector card",
        identity: {
          kind: "credit_card",
          issuer: "Synthetic Bank",
          network: "visa",
        },
        cardNumbers: [],
      }),
    "financialAccount.cardNumbers": () =>
      create("financialAccount", {
        name: "Vector reissued card",
        identity: {
          kind: "credit_card",
          issuer: "Synthetic Bank",
          network: "visa",
        },
        cardNumbers: [
          {
            last4: "1111",
            kind: "primary",
            validFrom: "2025-01-01",
            validTo: "2026-06-30",
            note: "Reissued",
          },
          {
            last4: "2222",
            kind: "primary",
            validFrom: "2026-07-01",
            validTo: null,
            note: null,
          },
        ],
      }),
    "vendor.agentHints": () =>
      create("vendor", {
        ...buildEntity("vendor", { name: "Vector Supply" }),
        agentHints: {
          ordersListUrl: "https://example.test/orders",
          pagination: "Next link at the bottom",
          orderLinkPattern: "/orders/",
          notes: ["Sign in first", "Orders load lazily"],
        },
      }),
    "expense.sourceClaims": () =>
      create("expense", {
        ...buildEntity("expense", {
          name: "Vector claim expense",
          cost: 10,
          trade: "other",
        }),
        sourceClaims: [claim],
      }),
    "ledgerTransfer.sourceClaims": async () => {
      const from = await create("ledgerParty", {
        name: "Vector sender",
        kind: "member",
      });
      const to = await create("ledgerParty", {
        name: "Vector receiver",
        kind: "guest",
      });
      return create("ledgerTransfer", {
        fromPartyId: from,
        toPartyId: to,
        amount: 10,
        date: "2026-08-20",
        sourceClaims: [claim],
      });
    },
  } satisfies Record<string, () => Promise<string>>;

  /**
   * The bulky nutrition blocks a meal's recipe rows read are not part of any input, so the vector
   * pins them as `null` rather than carrying a few hundred lines of "unavailable".
   */
  const elided = (id: string, value: z.core.util.JSONType) =>
    id === "meal.recipes"
      ? z
          .array(z.record(z.string(), z.json()))
          .parse(value)
          .map((row) => ({
            ...row,
            scaledTotals: null,
            recipe: {
              ...z.record(z.string(), z.json()).parse(row.recipe),
              totals: null,
            },
          }))
      : value;

  it("has a case for every generated vector", () => {
    const generated = vectors
      .map((vector) => `${vector.entity}.${vector.field}`)
      .filter((id) => Object.hasOwn(records, id));
    expect(generated.sort()).toEqual(Object.keys(records).sort());
  });

  it.each(Object.entries(records))(
    "%s: pins the payload the server reads, and the editor sends back the vector input",
    async (id, write) => {
      const [entity = "", field = ""] = id.split(".");
      const record = await read(entity, await write());
      const stableRead = stabilize(elided(id, record[field] ?? null));
      const schema = Object.entries(structuredValueSchemas).find(
        ([key]) => key === id,
      )?.[1];
      if (schema === undefined) throw new Error(`No valueSchema for ${id}`);
      const stableInput = stabilize(
        wireValue(project(record[field] ?? null, schema), schema),
      );
      const vector = vectors.find(
        (candidate) => `${candidate.entity}.${candidate.field}` === id,
      );
      if (vector === undefined) {
        throw new Error(
          `No vector for ${id}:\n${JSON.stringify({ read: stableRead, input: stableInput }, null, 2)}`,
        );
      }
      expect(stableRead).toEqual(vector.read);
      expect(stableInput).toEqual(vector.input);
    },
  );
});
