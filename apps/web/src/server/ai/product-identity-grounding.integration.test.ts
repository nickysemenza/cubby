import { productId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { aiUsage } from "~/server/db/schema";
import {
  variantDimension,
  variantLiteral,
} from "~/server/domains/product/repo/product-variant-evidence";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

const questionSubject = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("variant_literal"),
    dimension: variantDimension,
    productId,
  }),
  z.object({
    phase: z.literal("variant_relation"),
    dimension: variantDimension,
    first: variantLiteral,
    second: variantLiteral,
  }),
]);

// A relation must never run before its literals, borrow another dimension's
// literals, omit its source receipts, or multiply usage by its question count.
describe("batched Product variant grounding", () => {
  const ctx = withTestDb();
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([false, true])(
    "preserves evidence phases and receipts (one uncertain literal: %s)",
    async (uncertain) => {
      const runId = await ensureRun(
        ctx.db,
        ctx.actor,
        aiCallRunInput(ctx.actor),
      );
      const makeSide = async (name: string) => ({
        id: productId.parse(crypto.randomUUID()),
        name,
        verifiedModel: null,
        sources: [
          {
            id: crypto.randomUUID(),
            field: "name",
            quote: name,
            valueFingerprint: await sha256Hex(canonicalJson(name)),
            selectedVariant: null,
          },
        ],
      });
      const first = await makeSide("Blue M 2");
      const second = await makeSide("Red L 4");
      const wanted = new Map([
        [first.id, { color: "Blue", size: "M", pack: "2" }],
        [second.id, { color: "Red", size: "L", pack: "4" }],
      ]);
      const requests: {
        phase: string;
        questions: number;
        literalsFinished: boolean;
      }[] = [];
      const observed: z.infer<typeof questionSubject>[] = [];
      let literalsFinished = false;
      vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-gateway-token");
      vi.resetModules();
      vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body)).input;
        const questions = Object.entries(input.questions);
        const answers = Object.fromEntries(
          questions.map(([id, raw]) => {
            const question = z
              .object({
                instructions: z.string(),
                criteria: z.record(z.string(), z.string()),
              })
              .parse(raw);
            const subject = questionSubject.parse(
              JSON.parse(
                id === "selection"
                  ? input.state
                  : question.instructions.split(
                      "Evidence for this question only:\n",
                    )[1],
              ),
            );
            observed.push(subject);
            const dimension = subject.dimension;
            let choice: string;
            let probability = 0.99;
            if (subject.phase === "variant_literal") {
              const value = wanted.get(subject.productId)![dimension];
              choice = Object.entries(question.criteria).find(
                ([key, label]) =>
                  key !== "none" && JSON.parse(label).value === value,
              )![0];
              if (
                uncertain &&
                subject.productId === first.id &&
                dimension === "size"
              )
                probability = 0.7;
            } else {
              choice = "c1";
            }
            const keys = Object.keys(question.criteria);
            return [
              id,
              {
                type: "choice",
                choice,
                confidence: probability,
                probabilities: Object.fromEntries(
                  keys.map((key) => [
                    key,
                    key === choice
                      ? probability
                      : (1 - probability) / (keys.length - 1),
                  ]),
                ),
              },
            ];
          }),
        );
        const subjects = observed.slice(-questions.length);
        requests.push({
          phase: subjects[0]!.phase,
          questions: questions.length,
          literalsFinished,
        });
        if (subjects[0]!.phase === "variant_literal") literalsFinished = true;
        return Response.json({
          answers,
          usage: { input_tokens: 100, output_tokens: 20 },
        });
      });
      const { groundProductIdentityVariants } =
        await import("./product-identity-grounding");
      const result = await groundProductIdentityVariants({
        db: ctx.db,
        runId,
        first,
        second,
        model: "typesafe/jev",
        priorConflictIds: [],
        provenance: {
          dependencies: [],
          inputFingerprint: "synthetic",
          optionFingerprint: "synthetic",
          model: "typesafe/jev",
        },
      });
      expect(requests).toEqual([
        { phase: "variant_literal", questions: 6, literalsFinished: false },
        {
          phase: "variant_relation",
          questions: uncertain ? 2 : 3,
          literalsFinished: true,
        },
      ]);
      expect(
        observed
          .filter((subject) => subject.phase === "variant_relation")
          .map(({ dimension, first: left, second: right }) => ({
            dimension,
            first: left.productId,
            second: right.productId,
            firstValue: left.value,
            secondValue: right.value,
          })),
      ).toEqual(
        variantDimension.options
          .filter((dimension) => !uncertain || dimension !== "size")
          .map((dimension) => ({
            dimension,
            first: first.id,
            second: second.id,
            firstValue: wanted.get(first.id)![dimension],
            secondValue: wanted.get(second.id)![dimension],
          })),
      );
      expect(
        result?.dimensions.map(({ dimension, relation, decisions }) => ({
          dimension,
          relation,
          receipts: decisions.length,
        })),
      ).toEqual([
        { dimension: "color", relation: "different", receipts: 3 },
        {
          dimension: "size",
          relation: uncertain ? "unknown" : "different",
          receipts: uncertain ? 2 : 3,
        },
        { dimension: "pack", relation: "different", receipts: 3 },
      ]);
      for (const dimension of result!.dimensions) {
        for (const { literal, side } of [
          { literal: dimension.first, side: first },
          { literal: dimension.second, side: second },
        ].flatMap(({ literal, side }) =>
          literal ? [{ literal, side }] : [],
        )) {
          expect(literal).toMatchObject({
            productId: side.id,
            sourceId: side.sources[0]!.id,
            quote: side.name,
            valueFingerprint: side.sources[0]!.valueFingerprint,
          });
          expect(literal.quote.slice(literal.start, literal.end)).toBe(
            literal.value,
          );
        }
        expect(
          dimension.decisions
            .slice(0, 2)
            .map((receipt) => JSON.parse(receipt.request.subject).productId),
        ).toEqual([first.id, second.id]);
        for (const receipt of dimension.decisions)
          expect(receipt.inputFingerprint).toBe(
            await sha256Hex(canonicalJson(receipt.request)),
          );
      }
      expect(result!.dimensions[1]!.first === null).toBe(uncertain);
      const usage = await getDb(ctx.db)
        .select({ input: aiUsage.inputTokens, output: aiUsage.outputTokens })
        .from(aiUsage)
        .where(eq(aiUsage.runId, runId));
      expect(usage).toEqual([
        { input: 100, output: 20 },
        { input: 100, output: 20 },
      ]);
    },
  );
});
