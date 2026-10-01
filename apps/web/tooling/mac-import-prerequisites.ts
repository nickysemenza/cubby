import { Pool } from "pg";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { testUserId } from "@cubby/schemas/testing";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "../src/server/repo/member-login";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./scenarios/context";

/** Every Mac lane needs the statement's account; reconciliation never invents one. */
export async function seedMacStatementAccount(
  databaseURL: string,
  userId: string,
) {
  const pool = new Pool({ connectionString: databaseURL });
  try {
    const db = buildScenarioDatabase(pool);
    const kernel = buildKernelContext(db, testUserId(userId));
    let member = await currentMemberLedgerParty(db, kernel.actorContext);
    if (!member) {
      const created = await createFixtureWithContext(
        kernel,
        "ledgerParty",
        ledgerPartyCreateInput.parse({
          name: "Synthetic Mac reviewer",
          kind: "member",
        }),
      );
      await setMemberLoginParty(
        db,
        kernel.auth.userId,
        parseShortcodeFor("ledgerParty", created.id),
        kernel.actorContext,
      );
      member = await currentMemberLedgerParty(db, kernel.actorContext);
    }
    if (!member) throw new Error("Synthetic statement member was not resolved");
    const card = await createFixtureWithContext(
      kernel,
      "financialAccount",
      financialAccountCreateInput.parse({
        name: "Synthetic Mac Visa 4242",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: member.shortcode,
        sourceAliases: [
          {
            source: "monarch",
            alias: "Fixture Visa (...4242)",
            externalAccountId: null,
          },
        ],
      }),
    );
    return card.id;
  } finally {
    await pool.end();
  }
}
