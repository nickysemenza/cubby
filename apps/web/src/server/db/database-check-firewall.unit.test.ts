import { generateDrizzleJson } from "drizzle-kit/api";
import { expect, it } from "vitest";
import { z } from "zod";

import { REQUIRED_DATABASE_CHECKS } from "../../../scripts/db-check-contract";
import * as schema from "./schema";

it("declares exactly the eight storage firewall CHECKs", () => {
  const snapshot = z
    .object({
      tables: z.record(
        z.string(),
        z.object({ checkConstraints: z.record(z.string(), z.unknown()) }),
      ),
    })
    .parse(generateDrizzleJson(schema));
  const names = Object.values(snapshot.tables)
    .flatMap((table) => Object.keys(table.checkConstraints))
    .sort();
  expect(names).toEqual(
    REQUIRED_DATABASE_CHECKS.map((check) => check.name).sort(),
  );
});
