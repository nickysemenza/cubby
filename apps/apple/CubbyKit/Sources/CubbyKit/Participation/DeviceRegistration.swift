import Foundation

extension DevicePlatform {
    /// `macos` or `ios` — the only two platforms CubbyKit's native targets build for.
    public static var current: DevicePlatform {
        #if os(macOS)
            .macos
        #else
            .ios
        #endif
    }
}

/// Mirrors this install's participation switch onto its `Device` row, through the generic
/// generated client only (no bespoke op): list by `installationId`, then create or update.
public enum DeviceRegistration {
    public struct Info: Sendable {
        public let installationID: UUID
        public let name: String
        public let platform: DevicePlatform
        public let appVersion: String?
        public let osVersion: String?
        public let automaticWork: Bool

        public init(
            installationID: UUID, name: String, platform: DevicePlatform, appVersion: String?,
            osVersion: String?, automaticWork: Bool
        ) {
            self.installationID = installationID
            self.name = name
            self.platform = platform
            self.appVersion = appVersion
            self.osVersion = osVersion
            self.automaticWork = automaticWork
        }
    }

    /// Finds this install's `Device` row by `installationId` and creates or updates it.
    /// `resources.device.create` on the first call (`name`, `platform`, `appVersion`, `osVersion`,
    /// `automaticWork`); `resources.device.update` on every later one (`lastSeenAt`, `appVersion`,
    /// `osVersion`, `automaticWork`) — callers report a thrown error via `Diagnostics.report` and
    /// otherwise ignore it; this never blocks the UI by itself.
    public static func sync(_ info: Info, client: CubbyClient) async throws {
        let descriptor = EntityCatalog[.device]
        let installationID = info.installationID.uuidString.lowercased()
        let filters = EntityFilterState(["installationId": .single(installationID)])
        let page = try await client.list(descriptor, page: 1, pageSize: 1, filters: filters)

        var body: [String: JSONValue] = ["automaticWork": .bool(info.automaticWork)]
        if let appVersion = info.appVersion { body["appVersion"] = .string(appVersion) }
        if let osVersion = info.osVersion { body["osVersion"] = .string(osVersion) }

        if let existing = page.items.first {
            body["lastSeenAt"] = .string(try LenientISO8601DateTranscoder().encode(.now))
            try await client.update(descriptor, id: existing.id, patch: EntityPatch(values: body))
        } else {
            body["installationId"] = .string(installationID)
            body["name"] = .string(info.name)
            body["platform"] = .string(info.platform.rawValue)
            _ = try await client.create(descriptor, body: body)
        }
    }
}
