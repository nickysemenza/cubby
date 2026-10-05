import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Puts back the JSON `null`s a typed request body lost. swift-openapi-generator encodes every
/// optional property with `encodeIfPresent`, so a typed body can only omit a key, never send
/// `null` — yet an input may require a key that is nullable (an alias's `externalAccountId`, a
/// targeted run's `sourceId`, a recipe section's `name`), and an update reads an omitted key as
/// "leave as is" rather than "clear". `CubbyClient.sending(_:_:)` decodes a body the app composed
/// as JSON into the typed input (which validates it) and scopes that JSON here for the one call;
/// every `null` it holds where the typed body has no key is restored, at any depth. Nothing else
/// changes: a key the typed input dropped stays dropped. Outside a scope, requests pass through.
public struct JSONNullMiddleware: ClientMiddleware {
    @TaskLocal static var source: JSONValue?

    public init() {}

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        guard let source = Self.source else { return try await next(request, body, baseURL) }
        var typed = JSONValue.object([:])
        if let body {
            let data = try await Data(collecting: body, upTo: 1 << 20)
            if !data.isEmpty { typed = try JSONDecoder().decode(JSONValue.self, from: data) }
        }
        let encoded = try JSONEncoder().encode(Self.restoringNulls(typed, from: source))
        var request = request
        request.headerFields[.contentLength] = String(encoded.count)
        if request.headerFields[.contentType] == nil {
            request.headerFields[.contentType] = "application/json; charset=utf-8"
        }
        return try await next(request, HTTPBody(encoded), baseURL)
    }

    /// `typed` with every `null` key of `source` it lacks added back, recursing through objects
    /// and through arrays whose rows line up.
    static func restoringNulls(_ typed: JSONValue, from source: JSONValue) -> JSONValue {
        switch (typed, source) {
        case (.object(var object), .object(let original)):
            for (key, value) in original {
                if let present = object[key] {
                    object[key] = restoringNulls(present, from: value)
                } else if value == .null {
                    object[key] = .null
                }
            }
            return .object(object)
        case (.array(let items), .array(let originals)) where items.count == originals.count:
            return .array(zip(items, originals).map { restoringNulls($0, from: $1) })
        default:
            return typed
        }
    }
}
