import CubbyKit
import Foundation
import Observation
import Synchronization
import Testing

@testable import Cubby

@MainActor
@Suite("BackgroundActivityCenter")
struct BackgroundActivityCenterTests {
    private func activity(
        id: String, title: String = "Work", progress: Double? = nil,
        startedAt: Date = .now, isUserInitiated: Bool = false, kind: BackgroundActivity.Kind = .libraryScan
    ) -> BackgroundActivity {
        BackgroundActivity(
            id: id, kind: kind, title: title, phase: .running, progress: progress,
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

    /// A4's regression test: `sources` must not be `@ObservationIgnored`, or a source registered
    /// after a view's body last read `activities` (a late-registering `PhotoClassificationSweep`
    /// racing `preparePhotoSubsystem()`) never invalidates that reader and so never appears.
    @Test func registeringASourceInvalidatesActivitiesReaders() {
        let center = BackgroundActivityCenter()
        let fired = Mutex(false)
        withObservationTracking {
            _ = center.activities
        } onChange: {
            fired.withLock { $0 = true }
        }

        center.register(StubActivitySource(activities: [activity(id: "late-registration")]))

        #expect(fired.withLock { $0 })
    }

    /// B1's regression test: a kind-scoped `Slice` must filter to just those kinds, and its
    /// `primary`/`aggregateProgress`/`summary` must read exactly like a center holding only that
    /// filtered activity list — a Photos-screen strip can never phrase things differently from the
    /// iOS bar or the macOS sidebar looking at the same underlying activities unscoped.
    @Test func sliceFiltersByKindAndSharesSummaryWording() {
        let center = BackgroundActivityCenter()
        let scan = activity(id: "scan", title: "Scanning library", progress: 0.4, kind: .libraryScan)
        let job = activity(id: "job", title: "Describing image", kind: .companionJob)
        let source = StubActivitySource(activities: [scan, job])
        center.register(source)

        let slice = center.slice(BackgroundActivity.Kind.photoLibrary)
        #expect(slice.activities.map(\.id) == ["scan"])
        #expect(!slice.isEmpty)
        #expect(slice.primary?.id == "scan")

        let unscopedCenter = BackgroundActivityCenter()
        let unscopedSource = StubActivitySource(activities: [scan])
        unscopedCenter.register(unscopedSource)
        #expect(slice.summary == unscopedCenter.summary)
        #expect(slice.aggregateProgress == unscopedCenter.aggregateProgress)

        #expect(center.slice([.companionJob]).activities.map(\.id) == ["job"])
        #expect(center.slice([.hashRepair]).isEmpty)
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
