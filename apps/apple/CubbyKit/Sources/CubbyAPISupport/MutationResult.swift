/// Mutation responses retain their concrete item and effect types while sharing one codec.
/// Outputs ignore unknown keys so installed clients tolerate additive server changes.
public struct MutationResult<Item: Codable & Hashable & Sendable, Effects: Codable & Hashable & Sendable>:
    Codable, Hashable, Sendable
{
    public var items: [Item]
    public var sideEffects: Effects

    public init(items: [Item], sideEffects: Effects) {
        self.items = items
        self.sideEffects = sideEffects
    }
}
