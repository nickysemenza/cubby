import Foundation

/// A printed Cubby label as the device reads it offline: which catalog entity its prefix names and
/// the normalized code. Prefix match only — the server validates the body and resolves legacy
/// `P-`/`L-` labels, because every scan reaches it raw (`{kind: "scan"}` on
/// `inventory.scanAtLocation` and `product.findOrCreateByCode`). Offline work is limited to what
/// a label or barcode *is*, never to whether it exists.
public struct CubbyLabel: Sendable, Hashable {
    public let key: EntityKey
    public let code: String
    public var descriptor: EntityDescriptor { EntityCatalog[key] }

    /// A raw shortcode, or the last path segment of a printed label URL.
    public init?(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var candidate = value
        if let url = URL(string: value), url.scheme != nil, url.host() != nil,
            let last = url.pathComponents.last(where: { $0 != "/" })
        {
            candidate = last
        }
        guard let descriptor = EntityCatalog.descriptor(forShortcode: candidate) else { return nil }
        key = descriptor.key
        code = candidate.trimmingCharacters(in: .whitespaces).uppercased()
    }
}

extension ScanCodes {
    /// The identity a raw read resolves to before the server answers: a label's code, else the
    /// GTIN-14 a barcode or ISBN is stored as, else the trimmed text itself.
    public static func key(forScanned raw: String) -> String {
        if let label = CubbyLabel(raw) { return label.code }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return gtin14(trimmed) ?? trimmed
    }
}
