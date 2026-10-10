import { testUserId } from "@cubby/schemas/testing";
import { expect, it } from "vitest";

import { Database } from "~/server/db";
import { createTestRequestContext } from "~/server/testing/request-context";

import { handleEvidenceMediaRequest } from "./evidence";

it("preserves an authenticated retained-media SQL failure and its nested SQLSTATE", async () => {
  const member = testUserId("synthetic-media-member");
  const context = createTestRequestContext(
    new Database(() => {
      throw new Error("Media diagnostic test must not query a database");
    }),
    { auth: { userId: member } },
  );
  const response = await handleEvidenceMediaRequest(
    new Request("https://cubby.example/api/import/evidence"),
    {
      authenticate: async () => ({
        actor: {
          userId: member,
          sessionId: "synthetic-session",
          channel: "api",
        },
        authHeaders: new Headers(),
      }),
      context: async () => context,
      readMedia: async () => {
        throw new Error(
          "Failed query: select retained_media; params: synthetic",
          {
            cause: Object.assign(
              new Error("Synthetic relation does not exist"),
              { code: "42P01" },
            ),
          },
        );
      },
    },
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "Synthetic relation does not exist",
    diagnostics: {
      causes: [
        { message: "Failed query: select retained_media; params: synthetic" },
        { message: "Synthetic relation does not exist", code: "42P01" },
      ],
    },
  });
});

it.each(["", "?runId=malformed&targetId=malformed&evidenceId=malformed"])(
  "classifies invalid retained-media query input before reading storage: %s",
  async (query) => {
    const { readRunEvidenceMedia } =
      await import("~/server/purchase-import/run-evidence");
    const member = testUserId("synthetic-media-member");
    const context = createTestRequestContext(
      new Database(() => {
        throw new Error("Invalid media input must not query a database");
      }),
      { auth: { userId: member } },
    );
    const response = await handleEvidenceMediaRequest(
      new Request(`https://cubby.example/api/import/evidence${query}`),
      {
        authenticate: async () => ({
          actor: {
            userId: member,
            sessionId: "synthetic-session",
            channel: "api",
          },
          authHeaders: new Headers(),
        }),
        context: async () => context,
        readMedia: readRunEvidenceMedia,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "BAD_REQUEST",
      diagnostics: { stage: "input" },
    });
  },
);
