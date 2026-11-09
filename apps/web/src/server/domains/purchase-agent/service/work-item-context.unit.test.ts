import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
/**
 * Failures: a Mail import coordinator resends every earlier Email's reads on
 * each request, so a 50-Email Run reached ~970k context tokens; trimming
 * splits a tool call from its result, or drops a member's mid-Run message.
 */
import type { Message } from "@earendil-works/pi-ai";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  currentPhotoWorkItemMessages,
  currentWorkItemMessages,
} from "./work-item-context";

const user = (text: string): Message =>
  fromPartial({ role: "user", content: text, timestamp: 0 });
const call = (id: string, name: string): Message =>
  fromPartial({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
  });
const outcome = (id: string, name: string, text: string): Message =>
  fromPartial({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
  });
const claim = (id: string) => [
  call(id, "claim_next_import_work"),
  outcome(id, "claim_next_import_work", `claimed ${id}`),
];
const read = (id: string) => [
  call(id, "mcp__cubby__imports_read"),
  outcome(id, "mcp__cubby__imports_read", `synthetic body ${id}`),
];

describe("currentWorkItemMessages", () => {
  it("advances context only when a bundled publication returns the next durable claim", () => {
    const kickoff = user("Import.");
    const before = [kickoff, ...claim("first"), ...read("first-body")];
    const extract = call("extract", EXTRACT_ORDER_TOOL);
    const committed = outcome(
      "extract",
      EXTRACT_ORDER_TOOL,
      JSON.stringify({ kind: "commit_result", nextWork: { kind: "email" } }),
    );
    expect(currentWorkItemMessages([...before, extract, committed])).toEqual([
      kickoff,
      extract,
      committed,
    ]);
    const conflicted = outcome(
      "extract",
      EXTRACT_ORDER_TOOL,
      JSON.stringify({ kind: "commit_result" }),
    );
    const conflict = [...before, extract, conflicted];
    expect(currentWorkItemMessages(conflict)).toBe(conflict);
  });
  it("keeps the kickoff and only the current work item", () => {
    const kickoff = user("Import the Run's Emails.");
    const current = [...claim("c2"), ...read("r2")];
    const messages = [kickoff, ...claim("c1"), ...read("r1"), ...current];
    expect(currentWorkItemMessages(messages)).toEqual([kickoff, ...current]);
  });

  it("leaves a conversation with at most one claim unchanged", () => {
    const messages = [user("Import."), ...claim("c1"), ...read("r1")];
    expect(currentWorkItemMessages(messages)).toBe(messages);
    const unclaimed = [user("Import."), ...read("r0")];
    expect(currentWorkItemMessages(unclaimed)).toBe(unclaimed);
  });

  // pi records tool-list and instruction deltas as system entries at their
  // point in the transcript and never resends them; dropping one would leave
  // later requests on a stale tool list.
  it("keeps user and system messages between earlier work items", () => {
    const kickoff = user("Import.");
    const resume = user("Resume after the pause.");
    const delta: Message = fromPartial({
      role: "system",
      content: "Tool list changed.",
    });
    const messages = [
      kickoff,
      ...claim("c1"),
      ...read("r1"),
      resume,
      delta,
      ...claim("c2"),
    ];
    expect(currentWorkItemMessages(messages)).toEqual([
      kickoff,
      resume,
      delta,
      ...claim("c2"),
    ]);
  });
});

it("recovers photo pages from durable boundaries while retaining the full evidence transcript", () => {
  const kickoff = user("Group these photos.");
  const member = user("Keep the synthetic blue variant separate.");
  const legacy = [kickoff, ...read("old-page"), member];
  const recovery = currentPhotoWorkItemMessages(legacy);
  expect(recovery).toContain(kickoff);
  expect(recovery).toContain(member);
  expect(recovery.some((message) => message.role === "toolResult")).toBe(false);
  const page = (id: string, boundaryGroup: unknown) => [
    call(id, "mcp__cubby__run_read"),
    outcome(
      id,
      "mcp__cubby__run_read",
      JSON.stringify({
        remaining: true,
        images: [{ id: "IMG-4K7M" }],
        boundaryGroup,
      }),
    ),
  ];
  const first = [...legacy, ...page("p1", null), ...read("candidate")];
  const publication = [
    call("save", "mcp__cubby__run"),
    outcome(
      "save",
      "mcp__cubby__run",
      JSON.stringify({ savedGroupKeys: ["boundary"] }),
    ),
  ];
  expect(
    currentPhotoWorkItemMessages([...first, ...publication]).some(
      (message) => message.role === "toolResult",
    ),
  ).toBe(false);
  const boundary = {
    groupKey: "boundary",
    evidence: "Synthetic tag continues this garment",
  };
  const current = page("p2", boundary);
  const transcript = [...first, ...publication, ...current];
  expect(currentPhotoWorkItemMessages(transcript)).toEqual([
    kickoff,
    member,
    ...current,
  ]);
  expect(transcript).toContain(first[1]);
  const lookup = (id: string) => [
    call(id, "mcp__cubby__run_read"),
    outcome(id, "mcp__cubby__run_read", "synthetic lookup ".repeat(3_000)),
  ];
  const bounded = currentPhotoWorkItemMessages([
    ...transcript,
    ...lookup("earlier-candidates"),
    ...lookup("latest-candidates"),
  ]);
  expect(
    bounded
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
  ).toEqual(["p2", "latest-candidates"]);
});
