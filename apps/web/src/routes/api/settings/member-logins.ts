import { ledgerPartyShortcode, userId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { appErrorFromUnknown } from "~/server/errors/app-error";
import {
  listMemberLogins,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { createRequestContext, requireActor } from "~/server/request-context";

export const memberLoginsResponse = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
      ledgerParty: z
        .object({ shortcode: ledgerPartyShortcode, name: z.string() })
        .nullable(),
    }),
  ),
  parties: z.array(
    z.object({
      shortcode: ledgerPartyShortcode,
      name: z.string(),
      userId: z.string().nullable(),
    }),
  ),
});
export const memberLoginUpdate = z.object({
  userId,
  ledgerParty: ledgerPartyShortcode.nullable(),
});
export const memberLoginsError = z.object({ error: z.string() });

export const Route = createFileRoute("/api/settings/member-logins")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        return Response.json(
          memberLoginsResponse.parse(await listMemberLogins(context.db)),
        );
      },
      PATCH: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const parsed = memberLoginUpdate.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json(
            { error: "Choose a valid login and member ledger party." },
            { status: 400 },
          );
        }
        try {
          await setMemberLoginParty(
            context.db,
            parsed.data.userId,
            parsed.data.ledgerParty,
            context.actorContext,
          );
          return Response.json(
            memberLoginsResponse.parse(await listMemberLogins(context.db)),
          );
        } catch (error) {
          const appError = appErrorFromUnknown(error);
          if (appError) {
            return Response.json(
              memberLoginsError.parse({ error: appError.message }),
              { status: appError.code === "NOT_FOUND" ? 404 : 409 },
            );
          }
          throw error;
        }
      },
    },
  },
});
