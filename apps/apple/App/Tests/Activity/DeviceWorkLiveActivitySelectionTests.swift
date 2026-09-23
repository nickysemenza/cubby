import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Device work Live Activity")
struct DeviceWorkLiveActivitySelectionTests {
    private func activity(
        id: String, kind: BackgroundActivity.Kind, age: TimeInterval,
        userInitiated: Bool = false, progress: Double? = nil
    ) -> BackgroundActivity {
        BackgroundActivity(
            id: id, kind: kind, title: id, phase: .running, progress: progress,
            detail: "In progress", startedAt: Date.now.addingTimeInterval(-age),
            link: .localActivity(id), isUserInitiated: userInitiated, isCancellable: false)
    }

    @Test func ignoresBriefAndServerLinkedWork() {
        let now = Date.now
        #expect(DeviceWorkLiveSelection.select([], at: now) == nil)
        #expect(
            DeviceWorkLiveSelection.select(
                [
                    activity(id: "short", kind: .upload, age: 5),
                    activity(id: "server", kind: .companionJob, age: 120),
                ], at: now) == nil)
    }

    @Test func prioritizesSustainedUserWorkAndCountsOtherDeviceTasks() throws {
        let now = Date.now
        let selected = try #require(
            DeviceWorkLiveSelection.select(
                [
                    activity(id: "scan", kind: .libraryScan, age: 120, progress: 0.4),
                    activity(id: "upload", kind: .upload, age: 45, userInitiated: true, progress: 0.2),
                    activity(id: "server", kind: .companionJob, age: 120),
                ], at: now))
        #expect(selected.id == "upload")
        #expect(selected.additionalCount == 1)
        #expect(selected.progress == 0.2)
        #expect(selected.contentState.localActivityID == "upload")
        #expect(DeviceWorkLiveSelection.select([], at: now) == nil)
    }
}
