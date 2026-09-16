import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Injects `"key": null` into a `resources.<entity>.update` body for exactly the keys in
/// `clearedFields`. swift-openapi-generator encodes every optional property with
/// `encodeIfPresent`, so a typed update body can only omit a field, never clear it — and an
/// omitted field is "leave as is" on the server. The set is a task-local so the generic update
/// path scopes it to one call; every other operation, and an update with nothing cleared, passes
/// through untouched.
public struct PatchNullMiddleware: ClientMiddleware {
    @TaskLocal public static var clearedFields: Set<String> = []

    public init() {}

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let cleared = Self.clearedFields
        guard !cleared.isEmpty, Self.isResourceUpdate(operationID) else {
            return try await next(request, body, baseURL)
        }
        var fields: [String: JSONValue] = [:]
        if let body {
            let data = try await Data(collecting: body, upTo: 1 << 20)
            if !data.isEmpty { fields = try JSONDecoder().decode([String: JSONValue].self, from: data) }
        }
        for key in cleared { fields[key] = .null }
        let encoded = try JSONEncoder().encode(fields)
        var request = request
        request.headerFields[.contentLength] = String(encoded.count)
        if request.headerFields[.contentType] == nil {
            request.headerFields[.contentType] = "application/json; charset=utf-8"
        }
        return try await next(request, HTTPBody(encoded), baseURL)
    }

    static func isResourceUpdate(_ operationID: String) -> Bool {
        operationID.hasPrefix("resources.") && operationID.hasSuffix(".update")
    }
}
