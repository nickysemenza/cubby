import Foundation

/// This device's master "Automatic work on this device" switch, persisted locally and mirrored
/// onto the `Device` entity's `automaticWork` column (`DeviceRegistration.sync`) so the web can see
/// — and, via `Device.remotePaused`, override — it. Defaults to off: a freshly installed app is a
/// plain viewer until the person answers the first-sign-in sheet, which sets `answeredAt`.
public struct DeviceParticipation: Codable, Hashable, Sendable {
    private static let key = "cubby.participation"

    public var automaticWork: Bool
    public var answeredAt: Date?

    public init(automaticWork: Bool = false, answeredAt: Date? = nil) {
        self.automaticWork = automaticWork
        self.answeredAt = answeredAt
    }

    /// The stored value, or the off-until-answered default when nothing is stored yet or the
    /// stored JSON cannot be decoded.
    public static func load(from defaults: UserDefaults) -> DeviceParticipation {
        guard let data = defaults.data(forKey: key) else { return DeviceParticipation() }
        return (try? JSONDecoder.cubby().decode(DeviceParticipation.self, from: data))
            ?? DeviceParticipation()
    }

    public func save(to defaults: UserDefaults) {
        guard let data = try? JSONEncoder.cubby().encode(self) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
