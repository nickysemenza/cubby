import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { providerIdBackfillInput } from "@cubby/schemas/source-transaction-record";
import { testShortcode } from "@cubby/schemas/testing";
import { expect, it } from "vitest";
import { z } from "zod";

import { checkOriginalCsv } from "./provider-id-backfill-proof";

it("local parser counts original occurrences across chunks and validates normalized IDs and amounts while retaining raw columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-synthetic-csv-"));
  try {
    const file = join(directory, "synthetic.csv");
    const output = join(directory, "synthetic.json");
    writeFileSync(
      file,
      "\ufeffDate,Merchant,Account,Original Statement,Amount,Id,Notes\r\n\r\n" +
        '2026-01-01,Synthetic shop,Synthetic card,"SYNTHETIC\r\nSHOP",-12,synthetic-duplicate, original note \r\n' +
        Array.from(
          { length: 500 },
          (_, index) =>
            `2026-01-01,Synthetic shop,Synthetic card,SYNTHETIC ${index},${index === 1 ? "(-12)" : "-12"},${index === 0 ? " synthetic-0 " : `synthetic-${index}`},\r\n`,
        ).join("") +
        "2026-01-01,Synthetic shop,Synthetic card,SYNTHETIC SHOP,-12,synthetic-duplicate,\r\n",
    );
    execFileSync(
      "python3",
      [
        fileURLToPath(
          new URL(
            "../../../../../../../.agents/skills/financial-evidence-import/scripts/parse_statement_csv.py",
            import.meta.url,
          ),
        ),
        file,
        "--output",
        output,
        "--provider-id-backfill",
      ],
      { env: process.env },
    );
    const parsed = z
      .object({
        providerIdBackfillProofs: z.array(
          providerIdBackfillInput.omit({ recordId: true, collectionId: true }),
        ),
      })
      .parse(JSON.parse(readFileSync(output, "utf8")));
    expect(parsed.providerIdBackfillProofs).toHaveLength(502);
    const first = parsed.providerIdBackfillProofs[0];
    expect(first).toMatchObject({
      originalRow: {
        rowPosition: 3,
        providerData: { fields: { Notes: " original note " } },
      },
      sourceProof: {
        rowCount: 502,
        identityPositions: [3, 505],
        providerIdPositions: [3, 505],
      },
    });
    expect(
      parsed.providerIdBackfillProofs.at(-1)?.originalRow.rowPosition,
    ).toBe(505);
    for (const [index, rawId, rawAmount] of [
      [1, " synthetic-0 ", "-12"],
      [2, "synthetic-1", "(-12)"],
    ] as const) {
      const proof = providerIdBackfillInput.parse({
        ...parsed.providerIdBackfillProofs[index],
        recordId: testShortcode("sourceTransactionRecord", "normalized-csv"),
        collectionId: testShortcode("transactionImport", "normalized-csv"),
      });
      expect(proof.originalRow).toMatchObject({
        providerTransactionId: rawId.trim(),
        providerAmount: -12,
        providerData: {
          fields: { Id: rawId, Amount: rawAmount },
          csv: { sourceAmount: rawAmount },
        },
      });
      expect(() => checkOriginalCsv(proof)).not.toThrow();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
