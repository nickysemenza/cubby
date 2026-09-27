/**
 * Character set: 31 chars — the digits and uppercase letters minus the
 * scan/OCR-confusable ones (0/O, 1/I/L). New five-character bodies give
 * 31^5 = 28,629,151 codes per prefix. Existing four-character codes remain
 * valid public identifiers.
 *
 * Its own import-free module so the entity generator (a `nodenext` project)
 * can emit it into the Swift catalog without pulling in `shortcode.ts`.
 */
export const SHORTCODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const LEGACY_SHORTCODE_BODY_LENGTH = 4;
export const SHORTCODE_BODY_LENGTH = 5;
