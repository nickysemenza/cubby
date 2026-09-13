import CubbyAPI
import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Garden's edit methods submit complete editor values. Generated optional properties omit nil
/// when encoded, but PATCH needs explicit null to clear an association, note, or optional date.
/// Keep this normalization limited to these full editors; ordinary partial patches retain their
/// absent-field semantics.
struct GardenEditEncodingMiddleware: ClientMiddleware {
    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let nullableFields: [String]
        switch operationID {
        case Operations.Resources_gardenEntry_update.id:
            nullableFields = ["plantingId", "note", "harvestAmount"]
        case Operations.Resources_planting_update.id:
            nullableFields = [
                "sourceProductId", "intendedLocationId", "variety", "quantity", "notes", "plannedWindow",
                "plannedDate", "sowedOn", "transplantedOn",
            ]
        default:
            return try await next(request, body, baseURL)
        }
        guard let body else { return try await next(request, nil, baseURL) }
        let data = try await Data(collecting: body, upTo: 1 << 20)
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: data)
        for key in nullableFields where fields[key] == nil { fields[key] = .null }
        let encoded = try JSONEncoder().encode(fields)
        var request = request
        request.headerFields[.contentLength] = String(encoded.count)
        return try await next(request, HTTPBody(encoded), baseURL)
    }
}
