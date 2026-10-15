import Foundation
import Testing

@testable import Cubby

/// `PhotoLibraryStatus.derive`'s precedence matrix (`PhotoLibraryHeader.swift`): every branch is
/// exercised from plain `Inputs`, with no live `PhotoLibraryStore`/`PhotoMatchStore` — that is the
/// whole point of pulling this logic out of the view.
@MainActor
@Suite("PhotoLibraryStatus")
struct PhotoLibraryStatusTests {
    private func inputs(
        isParticipating: Bool = true,
        isLoadingLibrary: Bool = false,
        indexIsLoading: Bool = false,
        hasIndex: Bool = true,
        indexError: String? = nil,
        coverage: String = "Checked 100 Cubby images",
        scanStatus: String = "100 library photos checked",
        activities: [BackgroundActivity] = []
    ) -> PhotoLibraryStatus.Inputs {
        let center = BackgroundActivityCenter()
        for activity in activities { _ = center.begin(activity) }
        return PhotoLibraryStatus.Inputs(
            isParticipating: isParticipating, isLoadingLibrary: isLoadingLibrary,
            indexIsLoading: indexIsLoading, hasIndex: hasIndex, indexError: indexError,
            coverage: coverage, scanStatus: scanStatus,
            activities: center.slice(BackgroundActivity.Kind.photoLibrary))
    }

    private func activity(
        progress: Double? = nil, detail: String? = "41 of 100"
    ) -> BackgroundActivity {
        BackgroundActivity(
            id: "photo-library-scan", kind: .libraryScan, title: "Scanning library", phase: .running,
            progress: progress, detail: detail, startedAt: .now, link: .localActivity("photo-library-scan"),
            isUserInitiated: false, isCancellable: false)
    }

    @Test func indexErrorWinsOverEveryOtherCase() {
        let status = PhotoLibraryStatus.derive(
            inputs(
                isParticipating: false, isLoadingLibrary: true, indexError: "Server error",
                coverage: "Cubby could not be refreshed. Showing previously known matches.",
                activities: [activity(progress: 0.5)]))
        #expect(status.indicator == .warning)
        #expect(status.text == "Cubby could not be refreshed. Showing previously known matches.")
    }

    @Test func participationOffShowsTheFixedCaptionWithNoIndicator() {
        let status = PhotoLibraryStatus.derive(inputs(isParticipating: false))
        #expect(status.indicator == .none)
        #expect(status.text == "Automatic matching is off")
    }

    @Test func loadingLibraryIsIndeterminate() {
        let status = PhotoLibraryStatus.derive(inputs(isLoadingLibrary: true))
        #expect(status.indicator == .indeterminate)
        #expect(status.text == "Loading photo library…")
    }

    @Test func noIndexYetAndIndexLoadingReadsCheckingCubby() {
        let status = PhotoLibraryStatus.derive(inputs(indexIsLoading: true, hasIndex: false))
        #expect(status.indicator == .indeterminate)
        #expect(status.text == "Checking Cubby…")
    }

    @Test func activitiesWithAggregateProgressAreDeterminateAndUseTheSliceSummary() {
        let center = BackgroundActivityCenter()
        _ = center.begin(activity(progress: 0.41))
        let slice = center.slice(BackgroundActivity.Kind.photoLibrary)
        let status = PhotoLibraryStatus.derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: nil, coverage: "Checked 100 Cubby images",
                scanStatus: "100 library photos checked", activities: slice))
        #expect(status.indicator == .determinate(0.41))
        #expect(status.text == slice.summary)
    }

    @Test func activitiesWithoutProgressAreIndeterminate() {
        let status = PhotoLibraryStatus.derive(inputs(activities: [activity(progress: nil, detail: nil)]))
        #expect(status.indicator == .indeterminate)
    }

    @Test func idleHasNoTextSoTheRowIsNotRendered() {
        let status = PhotoLibraryStatus.derive(inputs())
        #expect(status.text == nil)
    }

    @Test func detailAlwaysCarriesBothScanStatusAndCoverage() {
        let status = PhotoLibraryStatus.derive(
            inputs(
                coverage: "Checked 100 Cubby images",
                scanStatus: "42 of 100 library photos checked · 58 unchecked")
        )
        #expect(status.detail.contains("42 of 100 library photos checked · 58 unchecked"))
        #expect(status.detail.contains("Checked 100 Cubby images"))
    }
}

/// `PhotoLibraryStages.derive`'s ordering/waiting/done/off precedence (`PhotoLibraryHeader.swift`),
/// exercised the same way `PhotoLibraryStatus.derive` is above — plain `Inputs`, no live stores.
@Suite("PhotoLibraryStages")
struct PhotoLibraryStagesTests {
    private func inputs(
        loadedAssetCount: Int = 100,
        totalAssetCount: Int? = 100,
        isLoadingLibrary: Bool = false,
        indexIsLoading: Bool = false,
        indexHasIndex: Bool = true,
        indexTotalCount: Int = 100,
        indexRemainingCount: Int = 0,
        indexError: String? = nil,
        isParticipating: Bool = true,
        isScanning: Bool = false,
        scannedCount: Int = 100,
        checkedCount: Int = 100,
        libraryCount: Int = 100,
        categories: PhotoLibraryStages.CategoriesInput? = PhotoLibraryStages.CategoriesInput(
            isRunning: false, analysedCount: 100, totalCount: 100)
    ) -> PhotoLibraryStages.Inputs {
        PhotoLibraryStages.Inputs(
            loadedAssetCount: loadedAssetCount, totalAssetCount: totalAssetCount,
            isLoadingLibrary: isLoadingLibrary, indexIsLoading: indexIsLoading, indexHasIndex: indexHasIndex,
            indexTotalCount: indexTotalCount, indexRemainingCount: indexRemainingCount,
            indexError: indexError, isParticipating: isParticipating, isScanning: isScanning,
            scannedCount: scannedCount, checkedCount: checkedCount, libraryCount: libraryCount,
            categories: categories)
    }

    private func stage(_ stages: [PhotoLibraryStages.Stage], _ id: String) -> PhotoLibraryStages.Stage {
        stages.first { $0.id == id }!
    }

    @Test func localReadInProgressLeavesTheLaterStagesWaiting() {
        let stages = PhotoLibraryStages.derive(
            inputs(
                loadedAssetCount: 4_000, totalAssetCount: 90_000, isLoadingLibrary: true,
                indexHasIndex: false, indexTotalCount: 0, checkedCount: 0, libraryCount: 4_000))
        #expect(stage(stages, "local").state == .running(value: 4_000, total: 90_000))
        #expect(stage(stages, "index").state == .waiting)
        #expect(stage(stages, "match").state == .waiting)
        #expect(stage(stages, "categories").state == .waiting)
    }

    @Test func indexErrorFailsWhileLocalStaysDone() {
        let stages = PhotoLibraryStages.derive(inputs(indexError: "Server error"))
        #expect(stage(stages, "local").state == .done)
        #expect(stage(stages, "index").state == .failed("Server error"))
    }

    @Test func matchingOffTurnsOffMatchAndCategories() {
        let stages = PhotoLibraryStages.derive(inputs(isParticipating: false))
        #expect(stage(stages, "match").state == .off("Off"))
        #expect(stage(stages, "categories").state == .off("Off"))
        // Local read and the remote index are device/network state, not the participation
        // switch — they keep reporting normally.
        #expect(stage(stages, "local").state == .done)
        #expect(stage(stages, "index").state == .done)
    }

    @Test func everyStageDoneCollapsesTheWholePanel() {
        let stages = PhotoLibraryStages.derive(inputs())
        for stage in stages { #expect(stage.state == .done) }
    }

    @Test func finishedScanWithUncheckedCloudPhotosIsDone() {
        let stages = PhotoLibraryStages.derive(inputs(checkedCount: 80))
        #expect(stage(stages, "match").state == .done)
        #expect(stage(stages, "match").caption() == "80 / 100 · 80%")
    }

    @Test func matchingOffWithNoIndexSettlesTheIndexStage() {
        let stages = PhotoLibraryStages.derive(
            inputs(indexHasIndex: false, indexTotalCount: 0, isParticipating: false))
        #expect(stage(stages, "index").state == .off("Off"))
    }

    @Test func idleIncompleteSweepSettlesInsteadOfWaiting() {
        let stages = PhotoLibraryStages.derive(
            inputs(
                categories: PhotoLibraryStages.CategoriesInput(
                    isRunning: false, analysedCount: 40, totalCount: 100)))
        #expect(stage(stages, "categories").state == .off("Paused"))
    }

    @Test func sweepThatNeverRanIsNotStartedRatherThanDone() {
        let stages = PhotoLibraryStages.derive(
            inputs(
                categories: PhotoLibraryStages.CategoriesInput(
                    isRunning: false, analysedCount: 0, totalCount: 0)))
        #expect(stage(stages, "categories").state == .off("Not started"))
    }

    @Test func noClassificationSweepShowsCategoriesOffRatherThanCrashing() {
        let stages = PhotoLibraryStages.derive(inputs(categories: nil))
        #expect(stage(stages, "categories").state == .off("Unavailable"))
    }
}

@Suite("PhotoStageETA")
struct PhotoStageETATests {
    private func running(_ count: Int, of total: Int) -> [PhotoLibraryStages.Stage] {
        [
            PhotoLibraryStages.Stage(
                id: "match", label: "Matching", state: .running(value: Double(count), total: Double(total)),
                count: count, total: total)
        ]
    }

    @Test func estimatesFromTheObservedRateAndResetsOnRestart() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var eta = PhotoStageETA()
        eta.record(running(0, of: 1_000), at: start)
        // One sample is not a rate yet.
        #expect(eta.remaining(for: "match", at: start) == nil)
        eta.record(running(100, of: 1_000), at: start.addingTimeInterval(10))
        // 10/s with 900 left.
        #expect(eta.remaining(for: "match", at: start.addingTimeInterval(10)) == 90)
        // A count that went backwards is a new run: no estimate until it moves again.
        eta.record(running(5, of: 1_000), at: start.addingTimeInterval(11))
        #expect(eta.remaining(for: "match", at: start.addingTimeInterval(11)) == nil)
    }

    @Test func formatsCoarsely() {
        #expect(PhotoStageETA.format(0.2) == "~1s")
        #expect(PhotoStageETA.format(42) == "~42s")
        #expect(PhotoStageETA.format(125) == "~3m")
        #expect(PhotoStageETA.format(3_600) == "~1h")
        #expect(PhotoStageETA.format(3_900) == "~1h 5m")
    }

    @Test func captionPutsPercentLastAndNeverRoundsUpToDone() {
        let stage = running(999, of: 1_000)[0]
        #expect(stage.caption() == "999 / 1,000 · 99%")
        #expect(stage.caption(eta: "~3m") == "999 / 1,000 · ~3m · 99%")
    }
}
