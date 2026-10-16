import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { testServiceConfig } from "./test-service-config";

// Presence must backfill without changing originals, stay exact for nullable,
// blank and HTML-only content, and follow every write without application flags.
it("preserves retained originals and derives text presence across migration and writes", async () => {
  const service = testServiceConfig();
  const adminUrl = `postgresql://postgres:password@${service.host}:${service.port}/postgres`;
  const name = `cubby_retained_text_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.href });
  const cases = [
    {
      content: { snippet: null, bodyText: null, bodyHtml: null },
      present: false,
    },
    {
      content: { snippet: "  ", bodyText: " ", bodyHtml: "   " },
      present: false,
    },
    {
      content: { snippet: "Synthetic summary", bodyText: null, bodyHtml: null },
      present: true,
    },
    {
      content: { snippet: null, bodyText: "Synthetic body", bodyHtml: null },
      present: true,
    },
    {
      content: {
        snippet: null,
        bodyText: null,
        bodyHtml: "<p>Synthetic original</p>",
      },
      present: true,
    },
    // PostgreSQL BTRIM removes spaces, not all JavaScript whitespace.
    {
      content: { snippet: "\t", bodyText: null, bodyHtml: null },
      present: true,
    },
    {
      content: { headers: { subject: "Synthetic header only" } },
      present: false,
    },
  ];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await client.connect();
    await migrateDatabase(drizzle(client), {
      through: "0073_photo_group_review_authority",
    });
    const party = await client.query(
      `INSERT INTO "LedgerParty" (shortcode,kind,name) VALUES ('LPY-4K7M','member','Synthetic original owner') RETURNING id`,
    );
    for (const [index, sample] of cases.entries())
      await client.query(
        `INSERT INTO "OrderMail" ("ledgerPartyId","rawChecksum",content) VALUES ($1,$2,$3::jsonb)`,
        [
          party.rows[0].id,
          `synthetic-${index}`,
          JSON.stringify(sample.content),
        ],
      );
    const originals = async () =>
      (
        await client.query(
          `SELECT id,"ledgerPartyId","rawChecksum",content,"createdAt","updatedAt" FROM "OrderMail" ORDER BY "rawChecksum"`,
        )
      ).rows;
    const before = await originals();
    await migrateDatabase(drizzle(client));
    expect(await originals()).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT "hasRetainedText" AS present FROM "OrderMail" ORDER BY "rawChecksum"`,
        )
      ).rows,
    ).toEqual(cases.map(({ present }) => ({ present })));
    await client.query(
      `UPDATE "OrderMail" SET content = '{"snippet":null,"bodyText":null,"bodyHtml":null}'::jsonb WHERE "rawChecksum"='synthetic-2'`,
    );
    expect(
      (
        await client.query(
          `SELECT "hasRetainedText" AS present FROM "OrderMail" WHERE "rawChecksum"='synthetic-2'`,
        )
      ).rows[0],
    ).toEqual({ present: false });
    const inserted = await client.query(
      `INSERT INTO "OrderMail" ("ledgerPartyId","rawChecksum",content) VALUES ($1,'synthetic-new','{"bodyText":"Synthetic later original"}'::jsonb) RETURNING "hasRetainedText" AS present`,
      [party.rows[0].id],
    );
    expect(inserted.rows[0]).toEqual({ present: true });
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
