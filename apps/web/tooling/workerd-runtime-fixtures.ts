import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect } from "vitest";

async function signUp(origin: string) {
  const email = `runtime-${randomUUID()}@example.test`;
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({
      email,
      password: "synthetic-runtime-password",
      name: "Synthetic Runtime Member",
    }),
  });
  if (!response.ok)
    throw new Error(`Sign-up ${response.status}: ${await response.text()}`);
  return email;
}

async function hasUser(databaseUrl: string, email: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query('SELECT 1 FROM "user" WHERE email = $1', [
      email,
    ]);
    return rows.length === 1;
  } finally {
    await pool.end();
  }
}

/** Authenticate, write through the Worker, and find the write in this database. */
export async function expectWriteLands(started: {
  origin: string;
  databaseUrl: string;
}) {
  const email = await signUp(started.origin);
  expect(await hasUser(started.databaseUrl, email)).toBe(true);
}
