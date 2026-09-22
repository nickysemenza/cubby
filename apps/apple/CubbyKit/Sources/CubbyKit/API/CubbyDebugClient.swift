import Foundation
import HTTPTypes

/// The CLI's `cubby call` escape hatch: any operation in the generated route table, by route,
/// with literal query values and a raw JSON body. Nothing decodes — the bytes are printed.
///
/// It exists because `OperationRoute.all` can be enumerated at runtime and the generated client
/// cannot. Everything the app uses goes through `CubbyClient` instead; this shares the credential
/// provider, the 401 invalidation, and `CubbyAPIError` with it, so both behave identically.
public actor CubbyDebugClient {
    public let baseURL: URL
    private let credentials: CredentialProvider
    private let identity: ClientIdentity
    private let session: URLSession

    public init(
        baseURL: URL, credentials: CredentialProvider, identity: ClientIdentity = .unknown,
        session: URLSession = .cubbyShared
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.identity = identity
        self.session = session
    }

    /// `query` values travel literally; a repeated key is how the API spells an array. `pathID`
    /// substitutes the route's `{id}`.
    public func call(
        _ route: OperationRoute,
        pathID: String? = nil,
        query: [(String, String)] = [],
        body: Data? = nil
    ) async throws -> Data {
        var path = route.path
        if let pathID {
            path = path.replacingOccurrences(of: "{id}", with: pathID)
        }
        guard
            var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        else {
            throw CubbyAPIError(status: 0, operationID: route.operationID, detail: nil)
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.0, value: $0.1) }
        }
        guard let url = components.url else {
            throw CubbyAPIError(status: 0, operationID: route.operationID, detail: nil)
        }

        var request = URLRequest(url: url)
        request.httpMethod = route.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var fields = HTTPFields()
        let authentication = await credentials.requestState()
        CubbyAuthMiddleware.apply(authentication, identity: identity, to: &fields)
        for field in fields {
            request.setValue(field.value, forHTTPHeaderField: field.name.rawName)
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        await credentials.processResponse(
            for: authentication,
            status: status,
            setAuthToken: http?.value(forHTTPHeaderField: "set-auth-token"),
            setCookieHeaders: Self.setCookieHeaders(from: http),
            responseURL: http?.url ?? url
        )
        guard (200..<300).contains(status) else {
            throw CubbyAPIError.decode(status: status, operationID: route.operationID, body: data)
        }
        return data
    }

    private static func setCookieHeaders(from response: HTTPURLResponse?) -> [String] {
        guard let response else { return [] }
        return response.allHeaderFields.compactMap { key, value -> [String]? in
            guard String(describing: key).caseInsensitiveCompare("Set-Cookie") == .orderedSame
            else { return nil }
            if let values = value as? [String] { return values }
            return [String(describing: value)]
        }.flatMap { $0 }
    }
}
