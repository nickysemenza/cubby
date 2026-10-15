/** Failure: workerd's WASM instantiation compacts Email HTML differently from
 * Node, so production triage reads a view no Node test exercised. */
import { compact_email_html } from "@cubby/recipebridge";
import { describe, expect, it } from "vitest";

import {
  EMAIL_FIXTURE_SUMMARY,
  summarizeEmailFixtures,
} from "./email-html.fixtures";

describe("compact_email_html in workerd", () => {
  it("compacts the shared Email fixtures exactly as Node does", () => {
    expect(summarizeEmailFixtures(compact_email_html)).toEqual(
      EMAIL_FIXTURE_SUMMARY,
    );
  });
});
