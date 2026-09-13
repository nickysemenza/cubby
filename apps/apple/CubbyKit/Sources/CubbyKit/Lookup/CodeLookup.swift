import Foundation

/// The reads a lookup needs. `CubbyClient` is the real one; tests stub it.
public protocol LookupService: Sendable {
    /// Existing products carrying this barcode (any GTIN spelling). Never creates.
    func products(matchingBarcode gtin: String) async throws -> [EntityRow]
    /// What the upstream barcode catalog knows, for a code Cubby has never seen.
    func lookupUPC(_ upc: String) async throws -> UPCLookup
}

extension CubbyClient: LookupService {}

/// What one raw scanner or search-field value turned out to be.
public enum LookupOutcome: Sendable, Hashable {
    /// A Cubby label (raw shortcode, printed label URL, or `cubby://` link) of any entity kind.
    case link(CubbyLink)
    /// A barcode or ISBN that at least one existing product carries.
    case products([EntityRow], code: ScanCode)
    /// A well-formed barcode or ISBN no product carries; `catalog` is the upstream lookup when
    /// it answered, so the caller can offer "create" with a name and picture.
    case unknownCode(ScanCode, catalog: UPCLookup?)
    /// Not a code at all — run it through text search.
    case text(String)
}

/// Resolves one value the way the web `/scan` page does, minus the create: Cubby labels first
/// (any entity, so a `LOC-` label opens the location rather than being refused as "wrong
/// kind"), then a barcode/ISBN against existing products, else plain text. Pure until a
/// barcode needs the server; a label never makes a request.
public struct CodeLookup: Sendable {
    private let service: any LookupService

    public init(service: any LookupService) {
        self.service = service
    }

    /// The offline half: what the value *is*, before any request. `.products` is never
    /// returned from here — a barcode comes back as `.unknownCode(_, catalog: nil)` and
    /// `resolve` asks the server.
    public static func classify(_ raw: String) -> LookupOutcome {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return .text("") }
        if let url = URL(string: value), let link = CubbyLink(url: url) {
            return .link(link)
        }
        if let parsed = Shortcode.extract(from: value) {
            return .link(.entity(parsed.key, id: parsed.code))
        }
        switch ScanCode.classify(value) {
        case .success(.product(let code)):
            return .link(.entity(.product, id: code.rawValue))
        case .success(let code):
            return .unknownCode(code, catalog: nil)
        case .failure:
            return .text(value)
        }
    }

    public func resolve(_ raw: String) async throws -> LookupOutcome {
        let offline = Self.classify(raw)
        guard case .unknownCode(let code, _) = offline else { return offline }
        let matches = try await service.products(matchingBarcode: code.value)
        if !matches.isEmpty {
            return .products(matches, code: code)
        }
        // The catalog is a nice-to-have for the "create" panel; its failure is not the
        // lookup's failure.
        let catalog = try? await service.lookupUPC(code.value)
        return .unknownCode(code, catalog: catalog)
    }
}
