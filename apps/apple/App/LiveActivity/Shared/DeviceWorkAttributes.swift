import ActivityKit
import Foundation

nonisolated struct DeviceWorkAttributes: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable {
        let title: String
        let detail: String
        let progress: Double?
        let estimatedRemaining: String?
        let additionalCount: Int
        let localActivityID: String
        var kindSymbol: String?
        var symbol: String { kindSymbol ?? "arrow.trianglehead.2.clockwise" }
        var destination: String?
        var hasEnded: Bool?

        func ending() -> Self {
            .init(
                title: title, detail: "Activity ended", progress: nil,
                estimatedRemaining: nil, additionalCount: 0, localActivityID: localActivityID,
                kindSymbol: "stop.circle", destination: destination, hasEnded: true)
        }

        var destinationURL: URL? {
            URL(
                string: destination
                    ?? (localActivityID == "companion-image-queue"
                        ? "cubby://activity" : "cubby://activity/local/\(localActivityID)"))
        }
    }

    let sessionID: String
}
