import { z } from "zod";

const isProviderUrl = (
  value: string,
  matches: (url: URL) => boolean,
): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && matches(url);
  } catch {
    return false;
  }
};

export const googleDriveFolderUrl = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(z.string().nullable())
  .nullable()
  .refine(
    (value) =>
      value === null ||
      isProviderUrl(
        value,
        (url) =>
          url.hostname === "drive.google.com" &&
          /^\/drive\/(?:u\/\d+\/)?folders\/[^/]+\/?$/.test(url.pathname),
      ),
    "Enter a valid Google Drive folder URL",
  )
  .describe(
    "Complete HTTPS drive.google.com folder URL; empty input clears the field",
  );

export const notionPageUrl = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(z.string().nullable())
  .nullable()
  .refine(
    (value) =>
      value === null ||
      isProviderUrl(value, (url) => {
        const notionHost =
          url.hostname === "notion.so" ||
          url.hostname.endsWith(".notion.so") ||
          url.hostname === "notion.site" ||
          url.hostname.endsWith(".notion.site") ||
          url.hostname === "app.notion.com";
        return notionHost && url.pathname.split("/").some(Boolean);
      }),
    "Enter a valid Notion page URL",
  )
  .describe(
    "Complete HTTPS notion.so/notion.site page URL (including subdomains) or app.notion.com page URL; empty input clears the field",
  );

export const projectStatusValues = [
  "planning",
  "not_started",
  "in_progress",
  "done",
] as const;
export const projectStatusSchema = z.enum(projectStatusValues);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const PROJECT_STATUS_LABELS = {
  planning: "Planning",
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
} as const satisfies Record<ProjectStatus, string>;

export const projectKindValues = [
  "furniture",
  "workshop",
  "household",
  "renovation",
  "garden",
  "trip",
] as const;
export const projectKindSchema = z.enum(projectKindValues);
export type ProjectKind = z.infer<typeof projectKindSchema>;
