import Foundation

/// One ordered level of a value's source chain (web `SourceStack`): which level decided, which
/// were skipped, and which blocked later sources. Reference chains, resolution evidence and
/// display-image chains share it; the server's order is kept verbatim.
public struct SourceStackLevel: Sendable, Hashable, Identifiable {
    public enum Status: Sendable, Hashable {
        case deciding, skipped, blocked
        /// A step effect this client does not know; shown, never interpreted.
        case unsupported(String)

        public var label: String {
            switch self {
            case .deciding: "Deciding"
            case .skipped: "Skipped"
            case .blocked: "Blocked"
            case .unsupported(let raw): "Unsupported step: \(raw)"
            }
        }
    }

    public struct Target: Sendable, Hashable {
        public let entity: EntityKey
        public let id: String

        public init(entity: EntityKey, id: String) {
            self.entity = entity
            self.id = id
        }
    }

    public let id: String
    /// The position in the server payload this level presents (chain row, source, image level).
    public let index: Int
    public let status: Status
    public let title: String
    public let target: Target?

    public init(id: String, index: Int, status: Status, title: String, target: Target?) {
        self.id = id
        self.index = index
        self.status = status
        self.title = title
        self.target = target
    }
}

public enum SourceStack {
    /// Resolution chain rows, each with the step that names it. A row without a step was
    /// evaluated as context only.
    public static func levels(chain: ReportRecordsBlock, steps: [FieldDecisionStep]?) -> [SourceStackLevel] {
        chain.rows.enumerated().map { index, row in
            let status: SourceStackLevel.Status
            switch steps?.first(where: { $0.rowIndex == index })?.effect {
            case .blocked?: status = .blocked
            case .used?, .fallback?: status = .deciding
            case .overridden?, .context?, nil: status = .skipped
            case .unrecognized(let raw)?: status = .unsupported(raw)
            }
            return SourceStackLevel(
                id: "\(index):\(row.title)", index: index, status: status, title: row.title, target: nil)
        }
    }

    /// Plain explanation sources. The result's inherited/default source decides only while the
    /// result describes current inputs; a stale cache keeps its provenance off live sources.
    public static func levels(sources: [FieldExplanationSource], envelope: FieldEnvelope?)
        -> [SourceStackLevel]
    {
        let deciding: FieldEnvelope.Source?
        switch (envelope?.result, envelope?.decision?.provenance) {
        case (.live?, .inherited(let source)?), (.cached(_, _, .fresh)?, .inherited(let source)?),
            (.live?, .default(let source?)?), (.cached(_, _, .fresh)?, .default(let source?)?):
            deciding = source
        default:
            deciding = nil
        }
        return sources.enumerated().map { index, source in
            let target = source.entity.map {
                SourceStackLevel.Target(entity: $0.entityKind, id: $0.entityId)
            }
            let decides =
                deciding != nil && target?.entity.rawValue == deciding?.entityKind
                && target?.id == deciding?.entityID
            return SourceStackLevel(
                id: "\(index):\(source.label)", index: index, status: decides ? .deciding : .skipped,
                title: source.label, target: target)
        }
    }

    /// Display-image levels: the level holding the chosen cover decides. Images are view only.
    public static func levels(imageChain: ImageChainExplanation) -> [SourceStackLevel] {
        imageChain.levels.enumerated().map { index, level in
            SourceStackLevel(
                id: "\(level.source?.entityId ?? "own"):\(level.label):\(index)", index: index,
                status: level.images.contains(where: \.chosen) ? .deciding : .skipped, title: level.label,
                target: level.source.map { .init(entity: $0.entityKind, id: $0.entityId) })
        }
    }
}
