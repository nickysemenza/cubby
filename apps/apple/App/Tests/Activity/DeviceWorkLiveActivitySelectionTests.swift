import CubbyKit
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

    @Test func ignoresBriefWork() {
        let now = Date.now
        #expect(DeviceWorkLiveSelection.select([], at: now) == nil)
        #expect(
            DeviceWorkLiveSelection.select(
                [
                    activity(id: "short", kind: .upload, age: 5)
                ], at: now) == nil)
    }

    @Test func prioritizesSustainedUserWorkAndCountsOtherDeviceTasks() throws {
        let now = Date.now
        let selected = try #require(
            DeviceWorkLiveSelection.select(
                [
                    activity(id: "scan", kind: .libraryScan, age: 120, progress: 0.4),
                    activity(id: "companion-image-queue", kind: .companionJob, age: 120, progress: 0.5),
                    activity(id: "upload", kind: .upload, age: 5, userInitiated: true, progress: 0.2),
                ], at: now))
        #expect(selected.id == "upload")
        #expect(selected.additionalCount == 2)
        #expect(selected.progress == 0.2)
        #expect(selected.contentState().localActivityID == "upload")
        #expect(DeviceWorkLiveSelection.select([], at: now) == nil)
    }

    @Test func queueProcessingIsEligibleImmediatelyAndEndsWithItsSource() throws {
        let now = Date.now
        let queue = BackgroundActivity(
            id: "companion-image-queue", kind: .companionJob, title: "Processing image queue",
            phase: .running, progress: 0.25,
            detail: "4 running · 20 done · about 3 minutes at this pace",
            startedAt: now, link: .activity, isUserInitiated: false, isCancellable: false)
        let selection = try #require(DeviceWorkLiveSelection.select([queue], at: now))
        let state = selection.contentState()
        #expect(state.title == queue.title)
        #expect(state.detail == queue.detail)
        #expect(state.progress == 0.25)
        #expect(state.estimatedRemaining == nil)
        #expect(DeviceWorkLiveSelection.select([], at: now) == nil)
    }

    @Test func estimateNeedsObservedProgressAndResetsForAnotherTask() throws {
        let now = Date.now
        var estimate = DeviceWorkProgressETA()
        let first = try #require(
            DeviceWorkLiveSelection.select(
                [activity(id: "scan", kind: .libraryScan, age: 40, progress: 0.2)], at: now))
        estimate.record(first, at: now)
        #expect(estimate.remaining(at: now) == nil)

        let advanced = try #require(
            DeviceWorkLiveSelection.select(
                [activity(id: "scan", kind: .libraryScan, age: 60, progress: 0.4)],
                at: now.addingTimeInterval(20)))
        estimate.record(advanced, at: now.addingTimeInterval(20))
        #expect(estimate.remaining(at: now.addingTimeInterval(20)) == 60)

        let other = try #require(
            DeviceWorkLiveSelection.select(
                [activity(id: "upload", kind: .upload, age: 40, progress: 0.5)],
                at: now.addingTimeInterval(20)))
        estimate.record(other, at: now.addingTimeInterval(20))
        #expect(estimate.remaining(at: now.addingTimeInterval(20)) == nil)
        estimate.record(nil, at: now.addingTimeInterval(21))
        #expect(estimate.remaining(at: now.addingTimeInterval(21)) == nil)
    }
}
