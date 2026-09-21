import Foundation

/// One installation identity joins browser-import and image-processing activity for this app.
/// Existing browser installations win migration so server history keeps its established device.
enum AppInstallationID {
    private static let key = "cubby.installation.deviceID"
    private static let browserKey = "purchaseImport.browserBridge.deviceID"
    private static let imageWorkerKey = "cubby.companionImageProcessing.deviceID"

    static var current: UUID {
        let defaults = UserDefaults.standard
        let value =
            id(for: browserKey, in: defaults)
            ?? id(for: key, in: defaults)
            ?? id(for: imageWorkerKey, in: defaults)
            ?? UUID()
        let encoded = value.uuidString.lowercased()
        defaults.set(encoded, forKey: key)
        defaults.set(encoded, forKey: browserKey)
        defaults.set(encoded, forKey: imageWorkerKey)
        return value
    }

    private static func id(for key: String, in defaults: UserDefaults) -> UUID? {
        defaults.string(forKey: key).flatMap(UUID.init(uuidString:))
    }
}
