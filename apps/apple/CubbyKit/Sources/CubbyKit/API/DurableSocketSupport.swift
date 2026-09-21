import Foundation

enum AuthenticatedSocketSupport {
    private static let localDevelopmentHosts = ["localhost", "127.0.0.1", "::1"]

    static func isSecureOrLocalDevelopment(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            let host = components.host?.lowercased()
        else { return false }
        return scheme == "wss" || (scheme == "ws" && localDevelopmentHosts.contains(host))
    }

    static func socketURL(baseURL: URL, path: String) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
            let host = components.host?.lowercased()
        else { throw URLError(.badURL) }
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        case "http" where localDevelopmentHosts.contains(host): components.scheme = "ws"
        default: throw URLError(.secureConnectionFailed)
        }
        components.path = path
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }

    static func request(url: URL, bearerToken: String, userAgent: String) throws -> URLRequest {
        guard isSecureOrLocalDevelopment(url) else { throw URLError(.secureConnectionFailed) }
        guard !bearerToken.isEmpty else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        return request
    }

    static func reconnectDelay(attempt: Int) -> Duration {
        .seconds(min(30, 1 << min(max(0, attempt - 1), 5)))
    }

    static func data(from message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .data(let data): data
        case .string(let string): Data(string.utf8)
        @unknown default: nil
        }
    }
}

enum AtomicCodableReplayFile {
    static func applicationSupportURL(
        directory: String, namespace: String, fileName: String
    ) throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
            create: true)
        let safeNamespace = namespace.map { character in
            character.isLetter || character.isNumber || character == "-" ? character : "_"
        }
        let destination = support.appendingPathComponent(
            "Cubby/\(directory)/\(String(safeNamespace.prefix(80)))", isDirectory: true)
        try FileManager.default.createDirectory(
            at: destination, withIntermediateDirectories: true)
        return destination.appendingPathComponent(fileName)
    }

    static func load<Value: Decodable>(
        _ type: Value.Type, from fileURL: URL, decoder: JSONDecoder
    ) throws -> Value? {
        guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else {
            return nil
        }
        return try decoder.decode(type, from: Data(contentsOf: fileURL))
    }

    static func save<Value: Encodable>(
        _ value: Value, to fileURL: URL, encoder: JSONEncoder
    ) throws {
        let data = try encoder.encode(value)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}
