import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("BackgroundActivityCenter")
struct BackgroundActivityCenterTests {
    private func activity(
        id: String, title: String = "Work", progress: Double? = nil,
        startedAt: Date = .now, isUserInitiated: Bool = false
    ) -> BackgroundActivity {
        BackgroundActivity(
            id: id, kind: .libraryScan, title: title, phase: .running, progress: progress,
            detail: nil, startedAt: startedAt, link: .localActivity(id),
            isUserInitiated: isUserInitiated, isCancellable: false)
    }

    @Test func summaryIsNilWhenNothingIsRunning() {
        let center = BackgroundActivityCenter()
        #expect(center.summary == nil)
        #expect(center.primary == nil)
    }

    @Test func summaryForOneActivityIsTitleAndPercent() {
        let center = BackgroundActivityCenter()
        let source = StubActivitySource(activities: [
            activity(id: "scan", title: "Scanning library", progress: 0.41)
        ])
        center.register(source)

        #expect(center.summary == "Scanning library · 41%")
    }

    @Test func summaryForOneActivityWithNoProgressOmitsPercent() {
        let center = BackgroundActivityCenter()
        let source = StubActivitySource(activities: [activity(id: "job", title: "Describing image")])
        center.register(source)

        #expect(center.summary == "Describing image")
    }

    @Test func summaryForSeveralActivitiesNamesThePrimaryAndAggregatesProgress() {
        let center = BackgroundActivityCenter()
        let source = StubActivitySource(activities: [
            activity(id: "scan", title: "Scanning library", progress: 0.2, isUserInitiated: false),
            activity(id: "upload", title: "Adding photos", progress: 0.8, isUserInitiated: true),
        ])
        center.register(source)

        // User-initiated wins primary selection even though it started later/has higher progress.
        #expect(center.primary?.id == "upload")
        #expect(center.summary == "2 tasks · Adding photos 50%")
    }

    @Test func primarySelectionFallsBackToDeterminateProgressThenEarliestStart() {
        let center = BackgroundActivityCenter()
        let earlier = Date.now.addingTimeInterval(-60)
        let later = Date.now
        let source = StubActivitySource(activities: [
            activity(id: "indeterminate-later", progress: nil, startedAt: later),
            activity(id: "determinate-earlier", progress: 0.5, startedAt: earlier),
            activity(id: "determinate-later", progress: 0.1, startedAt: later),
        ])
        center.register(source)

        // None are user-initiated, so: determinate beats indeterminate, then earliest start.
        #expect(center.primary?.id == "determinate-earlier")
    }

    @Test func visibilityGatingKeepsOnlyUserInitiatedWhenParticipationIsDisabled() {
        let center = BackgroundActivityCenter()
        let source = StubActivitySource(activities: [
            activity(id: "automatic", isUserInitiated: false),
            activity(id: "manual", isUserInitiated: true),
        ])
        center.register(source)
        center.participationEnabled = false

        #expect(center.visibleActivities.map(\.id) == ["manual"])
        #expect(Set(center.activities.map(\.id)) == ["automatic", "manual"])
    }

    @Test func sourcesAreReReadOnEveryAccess() {
        let center = BackgroundActivityCenter()
        let source = StubActivitySource(activities: [])
        center.register(source)

        #expect(center.activities.isEmpty)

        source.activities = [activity(id: "started-after-registration")]
        #expect(center.activities.map(\.id) == ["started-after-registration"])

        source.activities = []
        #expect(center.activities.isEmpty)
    }

    @Test func transientActivitiesBeginUpdateAndEnd() {
        let center = BackgroundActivityCenter()
        let id = center.begin(activity(id: "upload", title: "Adding photos", progress: nil))
        #expect(center.activities.first { $0.id == id }?.progress == nil)

        center.update(id: id, progress: 0.75, detail: "Uploading 3 of 4")
        #expect(center.activities.first { $0.id == id }?.progress == 0.75)
        #expect(center.activities.first { $0.id == id }?.detail == "Uploading 3 of 4")

        center.end(id: id)
        #expect(center.activities.isEmpty)
    }

    @Test func cancelInvokesTheRegisteredHandlerOnly() {
        let center = BackgroundActivityCenter()
        var cancelled = false
        center.register(cancel: { cancelled = true }, for: "job")

        center.cancel(id: "other-job")
        #expect(!cancelled)

        center.cancel(id: "job")
        #expect(cancelled)
    }
}

@MainActor
private final class StubActivitySource: BackgroundActivitySource {
    var activities: [BackgroundActivity]

    init(activities: [BackgroundActivity]) {
        self.activities = activities
    }

    var currentActivities: [BackgroundActivity] { activities }
}
