import Foundation

/// What a scanned or typed code means to the server. Mirrors the `code` union of
/// `inventory.scanAtLocation`: a barcode, an ISBN (sent as its GTIN-14), or a Cubby product
/// shortcode (from a printed QR label).
public enum ScanCode: Sendable, Hashable {
    case barcode(String)
    case isbn(String)
    case product(ProductCode)

    public var value: String {
        switch self {
        case .barcode(let v), .isbn(let v): v
        case .product(let code): code.rawValue
        }
    }

    public var kind: String {
        switch self {
        case .barcode: "barcode"
        case .isbn: "isbn"
        case .product: "product"
        }
    }
}

public enum ScanCodeError: Error, Sendable, Hashable {
    case empty
    /// A Cubby label for something that does not sit on a shelf (a location, a recipe...).
    case wrongKind(entity: String)
    /// A QR code that is a web link, not a Cubby label.
    case webLink
    case unrecognized

    public var message: String {
        switch self {
        case .empty: "Enter or scan a Cubby code, barcode, or ISBN."
        case .wrongKind(let entity): "That's a \(entity) label — nothing that sits on a shelf."
        case .webLink: "That QR code is a web link, not a Cubby label."
        case .unrecognized: "Use a Cubby shortcode, UPC/EAN/GTIN barcode, or valid ISBN."
        }
    }
}

/// Classification of one raw scanner value without I/O. Mirrors `apps/web/src/lib/scan-code.ts`
/// `resolveProductScan`: Cubby labels first (raw or as the last path segment of a label URL),
/// then ISBN before generic EAN because every ISBN-13 is also a valid barcode but creates a book,
/// then any 8/12/13/14-digit barcode.
extension ScanCode {
    public static func classify(_ raw: String) -> Result<ScanCode, ScanCodeError> {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return .failure(.empty) }

        if let shortcode = Shortcode.extract(from: value) {
            if shortcode.key == .product {
                return .success(.product(ProductCode(shortcode.code)))
            }
            return .failure(.wrongKind(entity: shortcode.singular.lowercased()))
        }
        if let url = URL(string: value), url.scheme != nil, url.host() != nil {
            return .failure(.webLink)
        }
        if let gtin14 = ISBN.normalizeToGTIN14(value) {
            return .success(.isbn(gtin14))
        }
        if value.allSatisfy(\.isNumber), [8, 12, 13, 14].contains(value.count) {
            return .success(.barcode(value))
        }
        return .failure(.unrecognized)
    }
}

/// Cubby shortcodes: `<PREFIX>-<4 chars>` over a 31-character alphabet with the OCR-confusable
/// characters removed. Prefixes come from the generated entity catalog, never a hand-kept list.
/// Also accepts, inbound only, the single-letter prefixes printed on labels before the 2026-07
/// cutover (`legacyShortcodePrefixes`) — a hit is rewritten to its entity's canonical prefix,
/// mirroring `parseShortcode` in `packages/shared/src/shortcode.ts`.
public enum Shortcode {
    public static let alphabet = EntityCatalog.shortcodeAlphabet

    /// INBOUND ONLY: nothing emits these, and the entity manifest no longer carries them; this
    /// mirrors `LEGACY_SHORTCODE_PREFIX` in `packages/shared/src/shortcode.ts`.
    private static let legacyShortcodePrefixes: [String: EntityKey] = ["P-": .product, "L-": .location]

    public struct Parsed: Sendable, Hashable {
        public let key: EntityKey
        public let singular: String
        /// Always the canonical prefix + body, even when the scanned text used a legacy prefix.
        public let code: String
    }

    public static func parse(_ text: String) -> Parsed? {
        let normalized = text.trimmingCharacters(in: .whitespaces).uppercased()
        guard let dash = normalized.firstIndex(of: "-"), dash > normalized.startIndex else { return nil }
        let prefix = String(normalized[...dash])
        let body = String(normalized[normalized.index(after: dash)...])
        guard body.count == EntityCatalog.shortcodeBodyLength, body.allSatisfy({ alphabet.contains($0) })
        else {
            return nil
        }
        if let descriptor = EntityCatalog.all.first(where: { $0.shortcodePrefix == prefix }) {
            return Parsed(key: descriptor.key, singular: descriptor.singular, code: prefix + body)
        }
        // Legacy single-letter prefix: every entity in this table has a canonical
        // `shortcodePrefix` by construction (the generator sources both from the
        // same `ShortcodeType` registry), so the rewrite below always succeeds.
        guard let key = legacyShortcodePrefixes[prefix] else { return nil }
        let descriptor = EntityCatalog[key]
        guard let canonicalPrefix = descriptor.shortcodePrefix else { return nil }
        return Parsed(key: descriptor.key, singular: descriptor.singular, code: canonicalPrefix + body)
    }

    /// A raw shortcode, or the last path segment of a printed label URL.
    public static func extract(from raw: String) -> Parsed? {
        if let direct = parse(raw) { return direct }
        guard let url = URL(string: raw), url.scheme != nil,
            let last = url.pathComponents.last(where: { $0 != "/" })
        else { return nil }
        return parse(last)
    }
}

/// ISBN normalization matching `packages/schemas/src/isbn.ts`: the canonical form is the GTIN-14
/// (`0` + ISBN-13), which is how book barcodes are stored.
public enum ISBN {
    public static func normalizeToGTIN14(_ value: String) -> String? {
        let compact = value.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        if compact.count == 14, compact.first == "0", isValidISBN13(String(compact.dropFirst())) {
            return compact
        }
        if isValidISBN10(compact) {
            let firstTwelve = "978" + compact.prefix(9)
            return "0" + firstTwelve + isbn13CheckDigit(firstTwelve)
        }
        if isValidISBN13(compact) {
            return "0" + compact
        }
        return nil
    }

    static func isbn13CheckDigit(_ firstTwelve: String) -> String {
        let sum = firstTwelve.enumerated().reduce(0) { total, pair in
            total + (pair.element.wholeNumberValue ?? 0) * (pair.offset.isMultiple(of: 2) ? 1 : 3)
        }
        return String((10 - sum % 10) % 10)
    }

    static func isbn10CheckDigit(_ firstNine: String) -> String {
        let sum = firstNine.enumerated().reduce(0) { total, pair in
            total + (pair.element.wholeNumberValue ?? 0) * (pair.offset + 1)
        }
        let check = sum % 11
        return check == 10 ? "X" : String(check)
    }

    static func isValidISBN10(_ value: String) -> Bool {
        guard value.count == 10, value.prefix(9).allSatisfy(\.isNumber) else { return false }
        let last = value.last!
        guard last.isNumber || last == "X" else { return false }
        return isbn10CheckDigit(String(value.prefix(9))) == String(last)
    }

    static func isValidISBN13(_ value: String) -> Bool {
        guard value.count == 13, value.allSatisfy(\.isNumber) else { return false }
        // 979-0 is ISMN (printed music), not ISBN.
        let bookland = value.hasPrefix("978") || (value.hasPrefix("979") && !value.hasPrefix("9790"))
        guard bookland else { return false }
        return isbn13CheckDigit(String(value.prefix(12))) == String(value.last!)
    }
}
