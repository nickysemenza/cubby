/// A bin that turned up during a walk and is not a direct child of the bin being counted.
/// Keyed by shortcode: scanning the same label twice queues one decision.
public struct AdoptableBin: Sendable, Hashable, Identifiable {
    public let id: LocationCode
    public let name: String
    public let type: String?
    /// Where it sits now: the sentence the review row reads out.
    public let currentParentName: String

    public init(id: LocationCode, name: String, type: String?, currentParentName: String) {
        self.id = id
        self.name = name
        self.type = type
        self.currentParentName = currentParentName
    }
}

public enum BinVerdict: Sendable, Hashable {
    /// Already a direct child. Nothing is written.
    case confirm
    /// Lives elsewhere. Queued for the bin's commit.
    case adopt(AdoptableBin)
    case refuse(reason: RefuseReason, message: String)

    public enum RefuseReason: Sendable, Hashable {
        case `self`, root, ancestor, unknownLabel
    }
}

/// What a scanned location label means from the bin being counted. Port of
/// `sweep-bin-plan.ts`: pure, direct-membership only (a grandchild is offered for promotion,
/// not confirmed), and the check order is load-bearing — a root is refused as a root before the
/// ancestor check would catch it, because "it holds the whole house" is the sentence that
/// explains the refusal.
public enum BinPlan {
    public static func plan(scanned: LocationCode, anchor: LocationCode, in tree: LocationTree) -> BinVerdict
    {
        guard let target = tree[scanned], let anchorNode = tree[anchor] else {
            return .refuse(
                reason: .unknownLabel, message: "\(scanned.rawValue) isn't a location in this tree.")
        }
        if target.id == anchor {
            return .refuse(reason: .self, message: "That's \(anchorNode.name) — the one you're counting.")
        }
        guard let parent = tree.parent(of: target.id) else {
            return .refuse(
                reason: .root, message: "\(target.name) holds the whole house — it can't sit on a shelf.")
        }
        if parent.id == anchor {
            return .confirm
        }
        if tree.isDescendant(anchor, of: target.id) {
            return .refuse(
                reason: .ancestor,
                message: "\(target.name) contains \(anchorNode.name) — it can't move inside it.")
        }
        return .adopt(
            AdoptableBin(
                id: target.id, name: target.name, type: target._type?.rawValue, currentParentName: parent.name
            ))
    }
}
