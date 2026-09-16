import Foundation

/// What an editor sends for one save: the keys whose value changed, and the keys the user
/// cleared. The two are kept apart because the generated client cannot encode JSON `null`
/// (swift-openapi-generator uses `encodeIfPresent`), so a cleared key travels through
/// `PatchNullMiddleware` rather than through the typed body.
public struct EntityPatch: Sendable, Hashable {
    public var values: [String: JSONValue]
    public var cleared: Set<String>

    public init(values: [String: JSONValue] = [:], cleared: Set<String> = []) {
        self.values = values
        self.cleared = cleared
    }

    public var isEmpty: Bool { values.isEmpty && cleared.isEmpty }

    public enum DiffError: Error, Sendable, Hashable {
        /// The draft cleared a key the server does not accept `null` for; the editor must keep
        /// such a field populated (or leave it untouched) rather than send an invalid patch.
        case clearedNonNullableKey(String)
    }

    /// The patch that turns `original` into `draft`, considering only the keys `draft` names.
    ///
    /// - An absent original key and an original `null` are the same thing: `JSONValue(encoding:)`
    ///   drops a typed value's absent optionals, so a draft `null` against either is unchanged.
    /// - A draft `null` on a key the original holds clears it when `nullableKeys` contains the
    ///   key, and throws `DiffError.clearedNonNullableKey` otherwise.
    /// - A value equal to the original is omitted; anything else is sent as a value.
    public static func diff(
        original: JSONValue?,
        draft: [String: JSONValue],
        nullableKeys: Set<String>
    ) throws -> EntityPatch {
        var patch = EntityPatch()
        for (key, value) in draft {
            // `JSONValue` is `ExpressibleByNilLiteral`, so this stays an explicit `.null` check
            // rather than a `nil`-returning closure the compiler would resolve to `.null`.
            var before = original?[key]
            if before == .null { before = nil }
            if value == .null {
                guard before != nil else { continue }
                guard nullableKeys.contains(key) else { throw DiffError.clearedNonNullableKey(key) }
                patch.cleared.insert(key)
            } else if value != before {
                patch.values[key] = value
            }
        }
        return patch
    }
}
