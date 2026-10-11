import CoreFoundation
import Foundation

/// Only the selected server may authenticate or command the native record navigator.
public struct NativeWorkspacePolicy: Sendable {
    public let baseURL: URL
    public init(baseURL: URL) { self.baseURL = baseURL }

    public func trusts(_ url: URL) -> Bool {
        func port(_ value: URL) -> Int { value.port ?? (value.scheme == "https" ? 443 : 80) }
        return ["http", "https"].contains(url.scheme?.lowercased() ?? "")
            && url.scheme?.lowercased() == baseURL.scheme?.lowercased()
            && url.host()?.lowercased() == baseURL.host()?.lowercased()
            && port(url) == port(baseURL) && url.user == nil && url.password == nil
    }

    public func evidenceURL(id: String) -> URL {
        var parts = URLComponents(url: baseURL.appending(path: id), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "nativeWorkspace", value: "run-evidence")]
        parts.fragment = "evidence"
        return parts.url!
    }

    public func isEvidence(_ url: URL, id: String) -> Bool {
        url.fragment == "evidence" && isEvidenceDocument(url, id: id)
    }

    public func isEvidenceDocument(_ url: URL, id: String) -> Bool {
        let entryPath = evidenceURL(id: id).path
        let canonicalPath = baseURL.appending(path: "runs").appending(path: id).path
        guard trusts(url), [entryPath, canonicalPath].contains(url.path),
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return false }
        return query == [URLQueryItem(name: "nativeWorkspace", value: "run-evidence")]
    }

    public func accepts(_ cookie: HTTPCookie) -> Bool {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return domain.lowercased() == baseURL.host()?.lowercased()
            && cookie.isHTTPOnly && cookie.path == "/"
            && (baseURL.scheme != "https" || cookie.isSecure)
            && (cookie.expiresDate.map { $0 > Date() } ?? true)
    }
}

public struct NativeWorkspaceMessage: Sendable {
    public struct Record: Sendable, Equatable {
        public let entity: EntityKey
        public let id: String
    }
    public enum Kind: String, Sendable { case ready, navigate, changed, authRequired, updateRequired }
    public let kind: Kind
    public let record: Record?
    public let replace: Bool
    public let entities: Set<EntityKey>?

    public static func decode(_ body: [String: Any]) throws -> Self {
        guard let number = body["version"] as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            let version = body["version"] as? Int, version == 1
        else {
            throw NativeWorkspaceError.incompatibleBridge
        }
        guard let type = body["type"] as? String, let kind = Kind(rawValue: type) else {
            throw NativeWorkspaceError.invalidMessage
        }
        var record: Record?
        if kind == .navigate {
            guard let raw = body["entity"] as? String, let key = EntityKey(rawValue: raw),
                let id = body["id"] as? String, validRecord(entity: key, id: id)
            else { throw NativeWorkspaceError.invalidMessage }
            record = Record(entity: key, id: id)
        }
        var entities: Set<EntityKey>?
        if let values = body["entities"] {
            guard let values = values as? [String] else { throw NativeWorkspaceError.invalidMessage }
            let keys = values.compactMap(EntityKey.init(rawValue:))
            guard keys.count == values.count else { throw NativeWorkspaceError.invalidMessage }
            entities = Set(keys)
        }
        return Self(
            kind: kind, record: record, replace: body["replace"] as? Bool ?? false, entities: entities)
    }

    private static func validRecord(entity: EntityKey, id: String) -> Bool {
        if entity == .usdaFood {
            return !id.isEmpty && id.allSatisfy { $0.isASCII && $0.isNumber }
        }
        guard !id.isEmpty, id.count <= 100,
            id.allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber || $0 == "-") })
        else { return false }
        return CubbyLabel(id).map { $0.key == entity && $0.code == id } ?? false
    }
}

public enum NativeWorkspaceError: LocalizedError {
    case incompatibleBridge, invalidMessage, missingCookie, bootstrap(Int, String)
    public var errorDescription: String? {
        switch self {
        case .incompatibleBridge: "The hosted workspace bridge is incompatible. Update Cubby."
        case .invalidMessage: "Invalid hosted workspace navigation message."
        case .missingCookie: "The workspace session response did not contain a trusted session cookie."
        case .bootstrap(let status, let body): "Workspace session HTTP \(status): \(body)"
        }
    }
}
