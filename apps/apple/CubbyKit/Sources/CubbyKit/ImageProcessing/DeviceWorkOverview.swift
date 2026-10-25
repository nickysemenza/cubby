import Foundation

/// `job.deviceBacklog` worded for Activity's banner: parked Apple-device image work, how many
/// devices claimed some in the last ten minutes, and the server's ETA at that pace. Every figure
/// is the server's; this type only words them.
public struct DeviceBacklogBanner: Sendable, Equatable {
    public let waiting: Int
    public let runsWaiting: Int
    public let workingDevices: Int
    /// Nil when nothing waits or nothing claims.
    public let etaSeconds: Int?

    public init(waiting: Int, runsWaiting: Int, workingDevices: Int, etaSeconds: Int?) {
        self.waiting = waiting
        self.runsWaiting = runsWaiting
        self.workingDevices = workingDevices
        self.etaSeconds = etaSeconds
    }

    init(_ output: JobDeviceBacklogOutput) {
        self.init(
            waiting: output.waiting, runsWaiting: output.runsWaiting,
            workingDevices: output.workingDevices, etaSeconds: output.etaSeconds)
    }

    public static func load(client: CubbyClient) async throws -> Self {
        Self(try await client.native_job_deviceBacklog(body: .object([:])))
    }

    /// The banner shows only while work waits.
    public var isShown: Bool { waiting > 0 }

    /// "N images waiting for an Apple device · M working · about X at the current pace"; the
    /// pace clause is omitted when the server has no ETA.
    public func headline(locale: Locale = .autoupdatingCurrent) -> String {
        var parts = [
            waiting == 1
                ? "1 image waiting for an Apple device" : "\(waiting) images waiting for an Apple device",
            "\(workingDevices) working",
        ]
        if let etaSeconds {
            parts.append("about \(Self.eta(seconds: etaSeconds, locale: locale)) at the current pace")
        }
        return parts.joined(separator: " · ")
    }

    /// Said when no device claimed work recently and this one is not processing either.
    public func idleNotice(thisDeviceProcessing: Bool) -> String? {
        guard isShown, workingDevices == 0, !thisDeviceProcessing else { return nil }
        return "No Apple device is processing — keep Cubby open on your Mac"
    }

    /// The two largest units, e.g. "3 hours, 20 minutes"; under a minute reads in seconds.
    static func eta(seconds: Int, locale: Locale) -> String {
        Duration.seconds(seconds).formatted(
            .units(
                allowed: [.days, .hours, .minutes, .seconds], width: .wide, maximumUnitCount: 2
            )
            .locale(locale))
    }
}

/// This household's Devices by code, and which one is this install (matched by
/// `installationId`). The household has a handful, so one page carries them all.
public struct HouseholdDevices: Sendable, Equatable {
    /// `DEV-` code → the Device's name.
    public let names: [String: String]
    /// This install's Device code; nil before `DeviceRegistration.sync` creates it.
    public let thisDevice: String?

    public init(names: [String: String], thisDevice: String?) {
        self.names = names
        self.thisDevice = thisDevice
    }

    init(rows: [EntityRow], installationID: UUID) {
        let installation = installationID.uuidString.lowercased()
        self.init(
            names: Dictionary(rows.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first }),
            thisDevice: rows.first { $0.raw["installationId"]?.stringValue == installation }?.id)
    }

    public static func load(client: CubbyClient, installationID: UUID) async throws -> Self {
        let page = try await client.list(EntityCatalog[.device], page: 1, pageSize: 100)
        return Self(rows: page.items, installationID: installationID)
    }
}

/// Processing image jobs (the imageJob `processing` saved view, live leases only) split by the
/// Device holding each lease (`leaseDeviceId`): this install's, then every other device's.
public struct ProcessingImageJobs: Sendable, Equatable {
    public struct DeviceGroup: Sendable, Equatable, Identifiable {
        /// The holding Device's code; empty when the server names none.
        public let id: String
        /// The Device's name, or its code when the directory has no row for it.
        public let name: String
        public let rows: [EntityRow]
    }

    public let thisDevice: [EntityRow]
    /// Other devices, by name.
    public let otherDevices: [DeviceGroup]

    public init(rows: [EntityRow], devices: HouseholdDevices) {
        var mine: [EntityRow] = []
        var byDevice: [String: [EntityRow]] = [:]
        var order: [String] = []
        for row in rows {
            let device = Self.leaseDevice(of: row) ?? ""
            if let this = devices.thisDevice, device == this {
                mine.append(row)
                continue
            }
            if byDevice[device] == nil { order.append(device) }
            byDevice[device, default: []].append(row)
        }
        thisDevice = mine
        otherDevices = order.map { code in
            DeviceGroup(
                id: code, name: code.isEmpty ? "Unknown device" : (devices.names[code] ?? code),
                rows: byDevice[code] ?? [])
        }
        .sorted { ($0.name, $0.id) < ($1.name, $1.id) }
    }

    public var isEmpty: Bool { thisDevice.isEmpty && otherDevices.isEmpty }

    /// The `DEV-` code holding the row's lease (`leaseDeviceId`).
    public static func leaseDevice(of row: EntityRow) -> String? {
        row.raw["leaseDeviceId"]?.stringValue
    }

    /// When the row's lease lapses unless renewed (`leaseExpiresAt`).
    public static func leaseExpiresAt(of row: EntityRow) -> Date? {
        row.raw["leaseExpiresAt"]?.stringValue.flatMap { try? LenientISO8601DateTranscoder().decode($0) }
    }

    /// The row's Run code (`runId`), when the job belongs to one.
    public static func runID(of row: EntityRow) -> String? {
        row.raw["runId"]?.stringValue
    }

    /// "lease ends in 42s", or "renewing" once the loaded expiry has passed: a live command
    /// renews every 15 s, so a lapsed time on screen means the rows are older than the lease.
    public static func leaseCountdown(expiresAt: Date, now: Date) -> String {
        let seconds = Int(expiresAt.timeIntervalSince(now).rounded(.up))
        return seconds > 0 ? "lease ends in \(seconds)s" : "renewing lease"
    }
}
