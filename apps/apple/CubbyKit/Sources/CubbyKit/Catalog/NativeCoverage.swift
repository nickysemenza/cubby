import Foundation

/// How the native app treats one manifest presentation id (renderer, slot, or hero action).
public enum NativeCoverageStatus: Equatable, Sendable {
    case implemented
    case generic
    case ownedElsewhere
    case unsupported(String)

    public var isUnsupported: Bool {
        if case .unsupported = self { return true }
        return false
    }
}

extension NativeCoverageStatus: Decodable {
    private enum CodingKeys: String, CodingKey { case status, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "implemented": self = .implemented
        case "generic": self = .generic
        case "ownedElsewhere": self = .ownedElsewhere
        case "unsupported": self = .unsupported(try container.decode(String.self, forKey: .reason))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .status, in: container, debugDescription: "Unknown native coverage status \(other)")
        }
    }
}

/// The reviewed native coverage of every manifest presentation id, decoded from the generated
/// `native-coverage.json` (declared in `packages/schemas/src/native-coverage.ts`). Keys are the
/// ids as the manifest spells them: kebab-case renderers, hero-action names, and entity-qualified
/// slots (`meal.nutrition`).
public struct NativeCoverageManifest: Decodable, Sendable {
    public let control: [String: NativeCoverageStatus]
    public let list: [String: NativeCoverageStatus]
    public let detail: [String: NativeCoverageStatus]
    public let heroAction: [String: NativeCoverageStatus]
    public let detailSlot: [String: NativeCoverageStatus]
    public let listSlot: [String: NativeCoverageStatus]
    /// The runner plan for each `implemented` hero action, keyed by its manifest id.
    public let heroActionPlan: [String: HeroActionPlan]

    /// Decoded on first use; a missing or undecodable file is a build defect
    /// (`NativeCoverageTests` fails CI).
    public static let shared: NativeCoverageManifest = {
        guard let url = Bundle.module.url(forResource: "native-coverage", withExtension: "json") else {
            fatalError("native-coverage.json is missing from the CubbyKit bundle; run `pnpm generate`.")
        }
        do {
            return try JSONDecoder().decode(NativeCoverageManifest.self, from: Data(contentsOf: url))
        } catch {
            fatalError("native-coverage.json does not decode: \(error)")
        }
    }()
}
