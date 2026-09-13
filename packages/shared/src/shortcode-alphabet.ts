/**
 * Character set: 31 chars — the digits and uppercase letters minus the
 * scan/OCR-confusable ones (0/O, 1/I/L). Four of them give 31^4 = 923,521
 * codes per prefix, against a largest table of ~1,800 rows.
 *
 * Its own import-free module so the entity generator (a `nodenext` project)
 * can emit it into the Swift catalog without pulling in `shortcode.ts`.
 */
export const SHORTCODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SHORTCODE_BODY_LENGTH = 4;
