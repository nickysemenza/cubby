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
        #expect(stage(stages, "match").state == .off("Automatic matching is off"))
        #expect(stage(stages, "categories").state == .off("Automatic matching is off"))
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
        #expect(stage(stages, "match").caption == "80 of 100 photos")
    }

    @Test func matchingOffWithNoIndexSettlesTheIndexStage() {
        let stages = PhotoLibraryStages.derive(
            inputs(indexHasIndex: false, indexTotalCount: 0, isParticipating: false))
        #expect(stage(stages, "index").state == .off("Automatic matching is off"))
    }

    @Test func idleIncompleteSweepSettlesInsteadOfWaiting() {
        let stages = PhotoLibraryStages.derive(
            inputs(
                categories: PhotoLibraryStages.CategoriesInput(
                    isRunning: false, analysedCount: 40, totalCount: 100)))
        #expect(stage(stages, "categories").state == .off("Not running"))
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
        #expect(stage(stages, "categories").state == .off("Categories are unavailable"))
    }
}
