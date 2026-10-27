import {
  automaticDecisionListInput,
  automaticDecisionListOut,
  suggestionRecordCountsInput,
  suggestionRecordCountsOut,
} from "@cubby/schemas/automatic-decision";
import {
  automaticRuleOut,
  automaticRulesOut,
  setAutomaticRuleInput,
} from "@cubby/schemas/automatic-rule";
import {
  enrollSuggestionCorrectionsInput,
  enrollSuggestionCorrectionsOut,
} from "@cubby/schemas/suggestion-correction";
import {
  acceptCleanSuggestionsInput,
  acceptCleanSuggestionsOut,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionListInput,
  suggestionListOut,
} from "@cubby/schemas/suggestion-list";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/** Pending Suggestions of every family; review goes through `assessment.review(Batch)`. */
export const suggestionsContract = defineContract(
  "suggestions",
  {
    automaticDecisions: query({
      description:
        "Already-applied decisions, newest first: Email relevance, automatic Email links, mail-import outcomes, and automatic-rule applications. Filter by family, recordIds and reviewStatus. Wrong records member Feedback through suggestions.review. Declared correction options use verdict wrong, intent apply, correction and expectedFingerprint; without a correction use intent history. Mail-import outcomes are history only; correct affected records through their domain actions. Decisions stay in this audit after review.",
      input: automaticDecisionListInput,
      output: automaticDecisionListOut,
      readPolicy: "strong",
      cache: { profile: "stable", tags: [["suggestions"]] },
    }),
    recordCounts: query({
      exposure: "view",
      note: "Per-row counts; agents read scoped suggestions_read.list rows",
      input: suggestionRecordCountsInput,
      output: suggestionRecordCountsOut,
      readPolicy: "strong",
      cache: {
        profile: "stable",
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    list: query({
      description:
        "The shared proposal queue: fields, statement transactions, connections and tag additions, Product pairs, image descriptions, and transfer pairs. Non-actionable candidates and already-applied automatic decisions are excluded. Scope by family, recordEntity, recordIds (every touched endpoint), runId and column filters. Declared filters accept include values, <column>Exclude values, <column>Presence and range <column>From/<column>To bounds; every supplied predicate must hold. Exclude keeps rows with no matching value, including null or absent values. Rows declare evidence, Strength, clean, actions, merge confirmation data and suppression. Review through suggestions.review or suggestions.review_batch, preserving expectedFingerprint and the declared application. Product merges require survivor choice and impact review; only clean rows qualify for bulk acceptance. Confidence never authorizes apply.",
      input: suggestionListInput,
      output: suggestionListOut,
      readPolicy: "strong",
      cache: {
        profile: "stable",
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    counts: query({
      exposure: "view",
      note: "Suggestions page and Run counts; agents read rows through suggestions_read.list",
      input: suggestionCountsInput,
      output: suggestionCountsOut,
      readPolicy: "strong",
      cache: {
        profile: "stable",
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    enrollCorrections: mutation({
      description:
        "Preview bounded historical field or image-description correction enrollment (family field or image_description, dryRun defaults true). Scans member correction candidates by opaque Feedback cursor; receiptBackedRoots is not proof of current applicability. Only on explicit instruction, dryRun false durably enrolls this page for automatic repair with current family authority/member-intent checks. Preserves completed Jobs and receipts; repeated enrollment does not reset work. No financial families, model work or rule changes. Continue with returned after until done, even when receiptBackedRoots is zero.",
      command: {
        label: "Enroll retained corrections",
        confirmation: null,
      },
      input: enrollSuggestionCorrectionsInput,
      output: enrollSuggestionCorrectionsOut,
      invalidates: ["suggestions"],
    }),
    acceptClean: mutation({
      exposure: "view",
      note: "Agents accept each clean row through suggestions.review_batch",
      command: { label: "Accept clean suggestions", confirmation: null },
      input: acceptCleanSuggestionsInput,
      output: acceptCleanSuggestionsOut,
      invalidates: [
        "suggestions",
        "product",
        "expense",
        "purchase",
        "vendor",
        "task",
        "project",
        "inventory",
        "cookbook",
        "sourceTransactionRecord",
        "financialTransaction",
        "settledSuggestions",
      ],
    }),
    /** Each Automatic rule with its switch and precision, computed on read. */
    rules: query({
      description:
        "Automatic rules: named, versioned family rules that apply matching Suggestions without review (statement_transaction.attach; statement_transaction.book_spending). Each returns its declared revision and the member switch; attach applies only while a member has it on for that revision.",
      input: z.object({}).strict(),
      output: automaticRulesOut,
      readPolicy: "strong",
      cache: { profile: "stable", tags: [["suggestions"]] },
    }),
    /** A member's switch: on requires eligibility, off is always allowed. */
    setRule: mutation({
      description:
        "Turn one Automatic rule on or off ({ruleKey, enabled}) on the member's instruction. On requires eligibility (read suggestions_read.rules) and refuses with the raw numbers otherwise; off is always allowed.",
      command: { label: "Set automatic rule", confirmation: null },
      input: setAutomaticRuleInput,
      output: automaticRuleOut,
      invalidates: ["suggestions"],
    }),
  },
  { exposure: "capability" },
);
