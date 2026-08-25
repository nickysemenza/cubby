import { describe, expect, it } from "vitest";
import {
  databaseStatementForTrace,
  MAX_DATABASE_STATEMENT_LENGTH,
} from "./db-query-telemetry";

describe("databaseStatementForTrace", () => {
  it("exports the SQL template without bind values", () => {
    const secret = "supplied-secret-must-not-be-exported";
    const query = {
      text: "SELECT * FROM product WHERE shortcode = $1",
      values: [secret],
    };

    const exported = databaseStatementForTrace(query);

    expect(exported).toBe(query.text);
    expect(exported).not.toContain(secret);
  });

  it("caps statement text", () => {
    expect(databaseStatementForTrace("x".repeat(1200))).toHaveLength(
      MAX_DATABASE_STATEMENT_LENGTH,
    );
  });
});
