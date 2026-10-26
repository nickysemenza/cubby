import Foundation

/// How the native app treats one manifest presentation id (renderer, slot, or hero action).
public enum NativeCoverageStatus: Equatable, Sendable {
    case implemented
    case generic
    case ownedElsewhere
    /// A reviewed web-only surface: native shows one row that opens it on web.
    case handoff(NativeWebHandoff)

    public var handoff: NativeWebHandoff? {
        if case .handoff(let handoff) = self { return handoff }
        return nil
    }
}

/// Where a `handoff` surface lives on web, the text that names it, and why it stays there.
public struct NativeWebHandoff: Equatable, Sendable {
    /// A detail section id the entity declares (the web hash); nil opens the page itself.
    public let section: String?
    /// List-route query parameters for a list-level handoff; empty otherwise.
    public let query: [String: String]
    public let label: String
    public let reason: String

    public init(section: String? = nil, query: [String: String] = [:], label: String, reason: String) {
        self.section = section
        self.query = query
        self.label = label
        self.reason = reason
    }
}

extension NativeCoverageStatus: Decodable {
    private enum CodingKeys: String, CodingKey { case status, web, reason }
    private enum WebKeys: String, CodingKey { case section, query, label }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "implemented": self = .implemented
        case "generic": self = .generic
        case "ownedElsewhere": self = .ownedElsewhere
        case "handoff":
            let web = try container.nestedContainer(keyedBy: WebKeys.self, forKey: .web)
            self = .handoff(
                NativeWebHandoff(
                    section: try web.decodeIfPresent(String.self, forKey: .section),
                    query: try web.decodeIfPresent([String: String].self, forKey: .query) ?? [:],
                    label: try web.decode(String.self, forKey: .label),
                    reason: try container.decode(String.self, forKey: .reason)))
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
    /// The verbs a `summary` or `recordList` section offers, keyed by `SectionActionID`.
    public let sectionAction: [String: NativeCoverageStatus]
    /// The runner plan for each `implemented` hero action, keyed by its manifest id.
    public let heroActionPlan: [String: HeroActionPlan]
    /// The runner plan for each verb a `collection` section offers, keyed by `CollectionActionID`.
    public let collectionActionPlan: [String: HeroActionPlan]
    /// Whether each collection verb acts on the record (`section`) or on one row (`row`).
    public let collectionActionScope: [String: CollectionActionScope]

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
