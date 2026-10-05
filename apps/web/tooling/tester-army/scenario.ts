import { readFileSync } from "node:fs";
import { z } from "zod";

const browserState = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
});

export function readBrowserCookies() {
  const file = z.string().min(1).parse(process.env.TESTER_ARMY_WEB_STATE);
  return browserState.parse(JSON.parse(readFileSync(file, "utf8"))).cookies;
}
