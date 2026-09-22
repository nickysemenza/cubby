import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("PhotoClassificationSweep")
struct PhotoClassificationSweepTests {
    private func candidate(_ id: String, day: Int, monthID: Date = Date(timeIntervalSince1970: 0))
        -> PhotoSweepScheduler.Candidate
    {
        PhotoSweepScheduler.Candidate(
            localIdentifier: id, creationDate: Date(timeIntervalSince1970: TimeInterval(day) * 86_400),
            monthID: monthID)
    }

    // MARK: - Ordering (visible months first, then newest→oldest)

    @Test func visibleMonthCandidatesSortAheadOfNonVisibleOnes() {
        let visibleMonth = Date(timeIntervalSince1970: 1_000)
        let hiddenMonth = Date(timeIntervalSince1970: 2_000)
        let candidates = [
            candidate("hidden-newest", day: 10, monthID: hiddenMonth),
            candidate("visible-oldest", day: 1, monthID: visibleMonth),
            candidate("visible-newest", day: 5, monthID: visibleMonth),
        ]
        let ordered = PhotoSweepScheduler.order(
            candidates: candidates, visibleMonthIDs: [visibleMonth], windowBound: nil,
            alreadyClassified: [])
        #expect(ordered == ["visible-newest", "visible-oldest", "hidden-newest"])
    }

    @Test func withinAGroupNewestSortsBeforeOldest() {
        let month = Date(timeIntervalSince1970: 0)
        let candidates = [
            candidate("oldest", day: 1, monthID: month),
            candidate("newest", day: 100, monthID: month),
            candidate("middle", day: 50, monthID: month),
        ]
        let ordered = PhotoSweepScheduler.order(
            candidates: candidates, visibleMonthIDs: [], windowBound: nil, alreadyClassified: [])
        #expect(ordered == ["newest", "middle", "oldest"])
    }

    // MARK: - Window bound

    @Test func candidatesOlderThanTheWindowBoundAreExcluded() {
        let bound = Date(timeIntervalSince1970: 50 * 86_400)
        let candidates = [
            candidate("too-old", day: 10),
            candidate("in-window", day: 60),
        ]
        let ordered = PhotoSweepScheduler.order(
            candidates: candidates, visibleMonthIDs: [], windowBound: bound, alreadyClassified: [])
        #expect(ordered == ["in-window"])
    }

    @Test func undatedCandidatesAreNeverExcludedByAWindowBound() {
        let bound = Date(timeIntervalSince1970: 50 * 86_400)
        let undated = PhotoSweepScheduler.Candidate(
            localIdentifier: "undated", creationDate: nil, monthID: .distantPast)
        let ordered = PhotoSweepScheduler.order(
            candidates: [undated], visibleMonthIDs: [], windowBound: bound, alreadyClassified: [])
        #expect(ordered == ["undated"])
    }

    @Test func thisYearAndLast12MonthsProduceDifferentBounds() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)  // 2023-11-14
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        #expect(PhotoAnalysisWindow.all.bound(now: now) == nil)
        let thisYear = try #require(PhotoAnalysisWindow.thisYear.bound(now: now, calendar: calendar))
        #expect(calendar.component(.year, from: thisYear) == calendar.component(.year, from: now))
        #expect(calendar.component(.month, from: thisYear) == 1)
        let last12 = try #require(PhotoAnalysisWindow.last12Months.bound(now: now, calendar: calendar))
        #expect(last12 < thisYear)
    }

    // MARK: - Skip already-classified

    @Test func alreadyClassifiedIdsAreExcludedRegardlessOfRecency() {
        let candidates = [candidate("done", day: 100), candidate("pending", day: 1)]
        let ordered = PhotoSweepScheduler.order(
            candidates: candidates, visibleMonthIDs: [], windowBound: nil, alreadyClassified: ["done"])
        #expect(ordered == ["pending"])
    }

    // MARK: - Pause on thermal / low power

    @Test func thermalStateAtOrAboveSeriousPausesTheSweep() {
        #expect(
            PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, thermalState: .fair,
                isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, thermalState: .serious,
                isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, thermalState: .critical,
                isLowPowerModeEnabled: false))
    }

    @Test func lowPowerModePausesTheSweep() {
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, thermalState: .nominal,
                isLowPowerModeEnabled: true))
    }

    @Test func inactiveTabOrSceneOrTheManualToggleAllPause() {
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: false, isSceneActive: true, isPaused: false, thermalState: .nominal,
                isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: false, isPaused: false, thermalState: .nominal,
                isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: true, thermalState: .nominal,
                isLowPowerModeEnabled: false))
    }

    // MARK: - Master "Automatic work on this device" switch

    @Test func participationOffPausesTheSweepLikeAnyOtherGate() {
        #expect(
            PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, isParticipating: true,
                thermalState: .nominal, isLowPowerModeEnabled: false))
        #expect(
            !PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, isParticipating: false,
                thermalState: .nominal, isLowPowerModeEnabled: false))
    }

    /// `isParticipating` defaults to `true` when omitted, so every pre-participation call site
    /// (and every other `shouldRun` test above) keeps its prior behavior unchanged.
    @Test func participationDefaultsToTrueWhenOmitted() {
        #expect(
            PhotoClassificationSweep.shouldRun(
                isTabActive: true, isSceneActive: true, isPaused: false, thermalState: .nominal,
                isLowPowerModeEnabled: false)
                == PhotoClassificationSweep.shouldRun(
                    isTabActive: true, isSceneActive: true, isPaused: false, isParticipating: true,
                    thermalState: .nominal, isLowPowerModeEnabled: false))
    }

    @Test func setParticipatingOffStopsARunningSweepAndOnRestartsIt() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let candidates = (0..<4).map { candidate("asset-\($0)", day: $0) }
        let sweep = PhotoClassificationSweep(
            analysisStore: store, window: .all,
            thermal: StubThermalSource(state: .nominal), power: StubPowerSource(lowPower: false),
            candidateProvider: { candidates },
            classify: { _ in
                PhotoClassificationSweep.Outcome(categories: ["home"], topLabels: [], classifyMs: 1)
            })
        sweep.setActive(true)
        sweep.setParticipating(false)
        #expect(!sweep.isRunning)
        // Give any in-flight classification a chance to land before asserting nothing progressed.
        try? await Task.sleep(for: .milliseconds(50))
        let classifiedWhileOff = try await store.classifiedCount(
            newerThan: PhotoClassificationSweep.classifyVersion)

        sweep.setParticipating(true)
        for _ in 0..<200 {
            if try await store.classifiedCount(newerThan: PhotoClassificationSweep.classifyVersion) == 4 {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try await store.classifiedCount(newerThan: PhotoClassificationSweep.classifyVersion) == 4)
        #expect(classifiedWhileOff < 4)
    }

    // MARK: - End-to-end: the running sweep actually records outcomes and honors pause

    @Test func runningSweepClassifiesEveryCandidateAndPauseStopsFurtherWork() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        let candidates = (0..<4).map { candidate("asset-\($0)", day: $0) }
        let sweep = PhotoClassificationSweep(
            analysisStore: store,
            // The fixture candidates use 1970 epoch dates; the default `.thisYear` window would
            // exclude every one of them before classification ever runs.
            window: .all,
            thermal: StubThermalSource(state: .nominal),
            power: StubPowerSource(lowPower: false),
            candidateProvider: { candidates },
            classify: { _ in
                PhotoClassificationSweep.Outcome(categories: ["home"], topLabels: [], classifyMs: 1)
            })
        sweep.setActive(true)
        for _ in 0..<200 {
            if try await store.classifiedCount(newerThan: PhotoClassificationSweep.classifyVersion) == 4 {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try await store.classifiedCount(newerThan: PhotoClassificationSweep.classifyVersion) == 4)
        sweep.setPaused(true)
        #expect(!sweep.isRunning)
    }

    // Regression: `setActive(true)` on the first Photos-tab visit ran with zero candidates
    // (`library.months` still empty) and `run()` never cleared `runTask`, so `reconcile()`'s
    // `guard runTask == nil` never passed again once real photos existed — the sweep silently
    // never started. `PhotosRootView` now calls `reconcile()` on every
    // `PhotoLibraryStore.monthsRevision` change; this reproduces that call directly against the
    // scheduler, without a real `PhotoLibraryStore`.
    @Test func sweepRearmsOnceCandidatesAppearAfterAnEmptyFirstRun() async throws {
        let store = try PhotoAnalysisStore.make(inMemory: true)
        final class CandidateBox: @unchecked Sendable { var candidates: [PhotoSweepScheduler.Candidate] = [] }
        let box = CandidateBox()
        let sweep = PhotoClassificationSweep(
            analysisStore: store, window: .all,
            thermal: StubThermalSource(state: .nominal), power: StubPowerSource(lowPower: false),
            candidateProvider: { box.candidates },
            classify: { _ in
                PhotoClassificationSweep.Outcome(categories: ["home"], topLabels: [], classifyMs: 1)
            })

        sweep.setActive(true)  // months still empty: run() sees zero candidates, returns at once.
        for _ in 0..<200 where sweep.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(!sweep.isRunning)

        box.candidates = [candidate("late-arrival", day: 1)]
        sweep.reconcile()  // what PhotosRootView calls on `library.monthsRevision` changing.

        for _ in 0..<200 {
            if try await store.classifiedCount(newerThan: PhotoClassificationSweep.classifyVersion) == 1 {
                break
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try await store.classifiedCount(newerThan: PhotoClassificationSweep.classifyVersion) == 1)
    }
}

private struct StubThermalSource: PhotoThermalSource {
    let state: ProcessInfo.ThermalState
    var thermalState: ProcessInfo.ThermalState { state }
}

private struct StubPowerSource: PhotoPowerSource {
    let lowPower: Bool
    var isLowPowerModeEnabled: Bool { lowPower }
}
