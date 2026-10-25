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
