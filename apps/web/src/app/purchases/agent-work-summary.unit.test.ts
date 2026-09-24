import type { PhotoRunImage } from "@cubby/schemas/photo-import-run";
import type { FlueConversationMessage } from "@flue/sdk";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import type { ImportRunDetail } from "~/lib/purchase-import-run-detail";

import {
  formatWorkDuration,
  summarizeAgentWork,
  summarizePhotoDescriptions,
} from "./agent-work-summary";

describe("agent work summary", () => {
  it("groups recorded work and reports only measured durations", () => {
    const messages = [
      fromPartial<FlueConversationMessage>({
        id: "agent-1",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "mcp__cubby__get_entities",
            toolCallId: "check-1",
            state: "output-available",
            input: {},
            output: {},
            durationMs: 450,
          },
          {
            type: "dynamic-tool",
            toolName: "mcp__cubby__get_entities",
            toolCallId: "check-2",
            state: "output-available",
            input: {},
            output: {},
            durationMs: 760,
          },
          {
            type: "dynamic-tool",
            toolName: "mcp__cubby__propose_photo_groups",
            toolCallId: "proposal-1",
            state: "output-available",
            input: {},
            output: {},
            durationMs: 180,
          },
        ],
      }),
    ];
    const operations = fromPartial<ImportRunDetail["operations"]>([
      {
        operationId: "commit-1",
        kind: "commit_photo_group",
        state: "completed",
        startedAt: "2026-09-20T16:00:00.000Z",
        completedAt: "2026-09-20T16:00:04.200Z",
      },
    ]);

    expect(summarizeAgentWork(messages, operations)).toEqual([
      {
        kind: "records",
        label: "Checked Cubby records",
        completed: 2,
        failed: 0,
        running: 0,
        durationMs: 1_210,
        timing: "tool",
      },
      {
        kind: "photo-groups",
        label: "Proposed item groups",
        completed: 1,
        failed: 0,
        running: 0,
        durationMs: 180,
        timing: "tool",
      },
      {
        kind: "photo-commit",
        label: "Saved reviewed photo groups",
        completed: 1,
        failed: 0,
        running: 0,
        durationMs: 4_200,
        timing: "elapsed",
      },
    ]);
  });

  it("does not mistake browser command dispatch for completed scraping", () => {
    const operations = fromPartial<ImportRunDetail["operations"]>([
      {
        operationId: "browser-1",
        kind: "browser_command",
        state: "completed",
        startedAt: "2026-09-20T16:00:00.000Z",
        completedAt: "2026-09-20T16:00:04.200Z",
      },
    ]);
    expect(summarizeAgentWork([], operations)).toEqual([]);
  });

  it("uses the whole parallel description batch's elapsed interval", () => {
    const images = fromPartial<PhotoRunImage[]>([
      {
        describe: "ready",
        describeStartedAt: "2026-09-20T16:00:00.000Z",
        describeCompletedAt: "2026-09-20T16:00:01.000Z",
      },
      {
        describe: "ready",
        describeStartedAt: "2026-09-20T16:00:00.300Z",
        describeCompletedAt: "2026-09-20T16:00:01.300Z",
      },
    ]);

    expect(summarizePhotoDescriptions(images)).toEqual([
      {
        kind: "image-description",
        label: "Processed image descriptions",
        completed: 2,
        failed: 0,
        running: 0,
        durationMs: 1_300,
        timing: "elapsed",
        attemptMs: null,
        waitingMs: null,
      },
    ]);
    expect(
      summarizePhotoDescriptions([
        fromPartial<PhotoRunImage>({
          describe: "ready",
          describeStartedAt: null,
          describeCompletedAt: null,
        }),
      ])[0]?.durationMs,
    ).toBeNull();
  });

  it("shows long image-job idle time separately from completed attempts", () => {
    const images = fromPartial<PhotoRunImage[]>([
      {
        describe: "ready",
        describeStartedAt: "2026-09-20T08:00:00.000Z",
        describeCompletedAt: "2026-09-20T14:38:55.500Z",
        describeAttemptMs: 4_000,
        describeWaitingMs: 23_931_500,
      },
    ]);
    const [step] = summarizePhotoDescriptions(images);
    expect(step?.attemptMs).toBe(4_000);
    expect(step?.waitingMs).toBe(23_931_500);
    expect(formatWorkDuration(step!.durationMs!)).toBe("6h 39m");
  });

  it("does not charge a new run for descriptions completed before it started", () => {
    const images = fromPartial<PhotoRunImage[]>([
      {
        describe: "ready",
        describeStartedAt: "2026-09-20T08:00:00.000Z",
        describeCompletedAt: "2026-09-20T14:38:55.500Z",
        describeAttemptMs: 4_000,
      },
    ]);
    expect(
      summarizePhotoDescriptions(images, "2026-09-21T08:00:00.000Z"),
    ).toEqual([
      {
        kind: "image-description-reused",
        label: "Reused earlier image descriptions",
        completed: 1,
        failed: 0,
        running: 0,
        durationMs: null,
        timing: "elapsed",
      },
    ]);
  });

  it("counts the gap between photo jobs as batch waiting", () => {
    const images = fromPartial<PhotoRunImage[]>([
      {
        describe: "ready",
        describeStartedAt: "2026-09-20T08:00:00.000Z",
        describeCompletedAt: "2026-09-20T08:00:01.000Z",
        describeAttemptMs: 1_000,
      },
      {
        describe: "ready",
        describeStartedAt: "2026-09-20T14:00:00.000Z",
        describeCompletedAt: "2026-09-20T14:00:01.000Z",
        describeAttemptMs: 1_000,
      },
    ]);
    expect(summarizePhotoDescriptions(images)[0]).toMatchObject({
      durationMs: 21_601_000,
      attemptMs: 2_000,
      waitingMs: 21_599_000,
    });
  });
});
