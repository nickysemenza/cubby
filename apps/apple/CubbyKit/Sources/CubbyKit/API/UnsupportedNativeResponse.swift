import Foundation

/// Retains a response this build cannot interpret without substituting a known variant.
public struct UnsupportedNativeResponse: Error, LocalizedError, Sendable {
    public let context: String
    public let raw: JSONValue

    public init(context: String, raw: JSONValue) {
        self.context = context
        self.raw = raw
    }

    public var errorDescription: String? {
        "Unsupported native response in \(context): \(String(reflecting: raw))"
    }
}
