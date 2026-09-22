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
