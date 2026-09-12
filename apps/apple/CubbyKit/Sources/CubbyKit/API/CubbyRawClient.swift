import Foundation
import HTTPTypes

/// The loosely-typed path into the API: generic entity lists and details for the Browse
/// screens, and any operation by route for the CLI `call` command.
///
/// It exists because the generated client cannot be enumerated at runtime and because every GET
/// with query parameters in this API JSON-encodes them, which the tagged OpenAPI runtime cannot
/// emit yet. It shares `CubbyAPIError`, the credential provider, and the 401 behaviour with the
/// typed client, so both paths behave identically.
public actor CubbyRawClient {
    public let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession
    private let decoder = JSONDecoder()

    public init(baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.session = session
    }

    /// `GET /api/v1/{basePath}?page=&pageSize=&sort=` decoded as a page of raw rows.
    public func list(
        basePath: String,
        page: Int = 1,
        pageSize: Int = 50,
        sort: String? = nil,
        filters: [String: JSONValue] = [:]
    ) async throws -> ListPage<JSONValue> {
        var query = filters
        query["page"] = .number(Double(page))
        query["pageSize"] = .number(Double(pageSize))
        if let sort { query["sort"] = .string(sort) }
        let route = try OperationRoute.lookup(method: .get, path: "/api/v1/\(basePath)")
        return try await call(route, query: query, as: ListPage<JSONValue>.self)
    }

    /// `GET /api/v1/{basePath}/{id}`.
    public func get(basePath: String, id: String) async throws -> JSONValue {
        try await call(OperationRoute.lookup(method: .get, path: "/api/v1/\(basePath)/{id}"), pathID: id)
    }

    /// Any operation by id, looked up in the generated route table.
    public func call(
        _ operationID: String,
        pathID: String? = nil,
        query: [String: JSONValue] = [:],
        body: JSONValue? = nil
    ) async throws -> JSONValue {
        try await call(OperationRoute.lookup(operationID), pathID: pathID, query: query, body: body)
    }

    /// Any operation by id, with the unwrapped `data` decoded into a hand-authored type.
    public func call<T: Decodable & Sendable>(
        _ operationID: String,
        pathID: String? = nil,
        query: [String: JSONValue] = [:],
        body: JSONValue? = nil,
        as type: T.Type
    ) async throws -> T {
        try await call(OperationRoute.lookup(operationID), pathID: pathID, query: query, body: body, as: type)
    }

    /// Any operation by id, with an `Encodable` body and a decoded result.
    public func call<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ operationID: String,
        pathID: String? = nil,
        query: [String: JSONValue] = [:],
        body: Body,
        as type: T.Type
    ) async throws -> T {
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
        return try await call(OperationRoute.lookup(operationID), pathID: pathID, query: query, body: encoded, as: type)
    }

    /// Any operation, with the unwrapped `data` decoded into a hand-authored type.
    public func call<T: Decodable & Sendable>(
        _ route: OperationRoute,
        pathID: String? = nil,
        query: [String: JSONValue] = [:],
        body: JSONValue? = nil,
        as type: T.Type
    ) async throws -> T {
        let value = try await call(route, pathID: pathID, query: query, body: body)
        return try Self.reencode(value, as: type)
    }

    /// Any operation. Returns the unwrapped `data` of the success envelope.
    public func call(
        _ route: OperationRoute,
        pathID: String? = nil,
        query: [String: JSONValue] = [:],
        body: JSONValue? = nil
    ) async throws -> JSONValue {
        var path = route.path
        if let pathID {
            path = path.replacingOccurrences(of: "{id}", with: pathID)
        }
        guard var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false) else {
            throw CubbyAPIError(status: 0, operationID: route.operationID, detail: nil)
        }
        if !query.isEmpty { components.queryItems = QueryEncoding.queryItems(query) }
        guard let url = components.url else {
            throw CubbyAPIError(status: 0, operationID: route.operationID, detail: nil)
        }

        var request = URLRequest(url: url)
        request.httpMethod = route.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var fields = HTTPFields()
        CubbyAuthMiddleware.apply(await credentials.current(), to: &fields)
        for field in fields {
            request.setValue(field.value, forHTTPHeaderField: field.name.rawName)
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 { await credentials.invalidate() }
            throw CubbyAPIError.decode(status: status, operationID: route.operationID, body: data)
        }
        let envelope = try decoder.decode(SuccessEnvelope<JSONValue>.self, from: data)
        return envelope.data
    }

    /// Round-trips through JSON so hand-authored types decode with the lenient Cubby date
    /// handling (`.000Z` timestamps) rather than Foundation's strict ISO-8601.
    private static func reencode<T: Decodable>(_ value: JSONValue, as type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder.cubby().decode(type, from: data)
    }
}

extension URLSession {
    /// One session for every Cubby request: default URLCache (images and lists stay warm),
    /// no cookie storage so sign-in never silently upgrades to an ambient cookie session.
    public static let cubbyShared: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: configuration)
    }()
}
