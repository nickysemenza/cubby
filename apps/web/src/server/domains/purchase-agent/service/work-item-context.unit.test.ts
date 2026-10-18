/**
 * Failures: a Mail import coordinator resends every earlier Email's reads on
 * each request, so a 50-Email Run reached ~970k context tokens; trimming
 * splits a tool call from its result, or drops a member's mid-Run message.
 */
import type { Message } from "@earendil-works/pi-ai";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { currentWorkItemMessages } from "./work-item-context";

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

  it("keeps user messages between earlier work items", () => {
    const kickoff = user("Import.");
    const resume = user("Resume after the pause.");
    const messages = [
      kickoff,
      ...claim("c1"),
      ...read("r1"),
      resume,
      ...claim("c2"),
    ];
    expect(currentWorkItemMessages(messages)).toEqual([
      kickoff,
      resume,
      ...claim("c2"),
    ]);
  });
});
