import CubbyKit
import SwiftUI

/// The ownership filter `PhotoLibraryBrowser` segments the grid by. Lives outside the browser
/// (rather than nested inside it, as it used to be) so `PhotoLibraryHeader` — a sibling view, not
/// a child — can bind to it; `PhotoLibraryBrowser.Filter` is a `typealias` back to this so its own
/// `FilteredMonthAssetsCache` and filtering logic need no other change.
enum PhotoLibraryFilter: String, CaseIterable {
    case all = "All"
    case missing = "Not in Cubby"
    case found = "In Cubby"
}

/// The Photos header's status line, reduced to data: what indicator to draw and what one line of
/// text to show, computed from plain inputs rather than read live off `PhotoLibraryStore`/
/// `PhotoMatchStore`/`BackgroundActivityCenter` inside a view body. That split is what makes the
/// precedence below unit-testable (`PhotoLibraryStatusTests`) without a live PhotoKit library, and
/// previewable without one either — a status-row `#Preview` just calls `derive(...)` on values it
/// wrote itself (see the bottom of this file).
struct PhotoLibraryStatus: Equatable {
    enum Indicator: Equatable {
        /// Nothing worth drawing — either everything is caught up, or the one thing worth saying
        /// (participation is off) is conveyed by the text alone.
        case none
        case indeterminate
        case determinate(Double)
        case warning
    }

    struct Inputs {
        let isParticipating: Bool
        let isLoadingLibrary: Bool
        let indexIsLoading: Bool
        let hasIndex: Bool
        let indexError: String?
        let coverage: String
        let scanStatus: String
        let activities: BackgroundActivityCenter.Slice
    }

    var indicator: Indicator
    /// `nil` means the status row is not rendered at all — the idle, fully-caught-up state.
    var text: String?
    /// Concatenates `scanStatus`, `coverage`, and the primary activity's own detail (when one is
    /// running) so a `.help()` hover or VoiceOver's accessibility value never loses information the
    /// single-line `text` had to drop to stay on one line.
    var detail: String

    /// First match wins. Order matters: an index error is worth surfacing even while participation
    /// is off (the user turned off automatic work, but a stale error is still a stale error), and
    /// "loading the local library" is more urgent than "still loading the remote index" since nothing
    /// else on screen is usable until PhotoKit finishes enumerating.
    static func derive(_ inputs: Inputs) -> PhotoLibraryStatus {
        let detail = [inputs.scanStatus, inputs.coverage, inputs.activities.primary?.detail]
            .compactMap { $0 }
            .joined(separator: " · ")
        if inputs.indexError != nil {
            return PhotoLibraryStatus(indicator: .warning, text: inputs.coverage, detail: detail)
        }
        if !inputs.isParticipating {
            return PhotoLibraryStatus(indicator: .none, text: "Automatic matching is off", detail: detail)
        }
        if inputs.isLoadingLibrary {
            return PhotoLibraryStatus(
                indicator: .indeterminate, text: "Loading photo library…", detail: detail)
        }
        if !inputs.hasIndex && inputs.indexIsLoading {
            return PhotoLibraryStatus(indicator: .indeterminate, text: "Checking Cubby…", detail: detail)
        }
        if !inputs.activities.isEmpty {
            let indicator: Indicator =
                inputs.activities.aggregateProgress.map(Indicator.determinate) ?? .indeterminate
            return PhotoLibraryStatus(indicator: indicator, text: inputs.activities.summary, detail: detail)
        }
        return PhotoLibraryStatus(indicator: .none, text: nil, detail: detail)
    }
}

/// Replaces `PhotoLibraryBrowser.controls`: that stack was up to twelve lines of chrome (a
/// segmented filter, a category chip row, a mini spinner literally captioned "Loading photo
/// library", a bare refresh button, a six-line monospaced debug dump, and a two-line explainer)
/// above every grid the Photos screen ever shows. This collapses the idle case to one row and
/// keeps everything else to at most three: filter+chips, a status line (only while something is
/// worth reporting), and a footnote (only under the "Not in Cubby" filter or an active category).
struct PhotoLibraryHeader: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var filter: PhotoLibraryFilter
    @Binding var selectedCategory: PhotoCategory?
    /// `!picker` — the picker sheet's browser instance shows the ownership filter alone, with no
    /// category chips and no per-category footnote.
    let showsCategories: Bool
    let unanalysedCount: Int

    /// Sized to the same slim bar `BackgroundActivityBar.swift` draws for determinate progress, so
    /// a photo import's activity reads identically whether it is seen here or in the bottom
    /// accessory.
    @ScaledMetric(relativeTo: .caption) private var barWidth = 44.0

    private var library: PhotoLibraryStore { appModel.photoLibrary }
    private var matches: PhotoMatchStore { appModel.photoMatches }

    private var status: PhotoLibraryStatus {
        .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: library.isParticipating,
                isLoadingLibrary: library.isLoadingLibrary,
                indexIsLoading: matches.isLoading,
                hasIndex: matches.hasIndex,
                indexError: matches.error,
                coverage: matches.coverage,
                scanStatus: library.scanStatus,
                activities: appModel.backgroundActivity.slice(BackgroundActivity.Kind.photoLibrary)))
    }

    /// One line, visible to everyone (not gated on developer overlays — this is an explicit product
    /// decision, not a debug layer) for exactly as long as PhotoKit enumeration is in flight. `nil`
    /// the instant `isLoadingLibrary` clears, which is also exactly when `status.text` stops saying
    /// "Loading photo library…" — the row that hosts this disappears on its own.
    private var loadStepCaption: String? {
        guard library.isLoadingLibrary else { return nil }
        let progress =
            library.expectedBatchCount.map { "\(library.loadedBatchCount) of \($0)" }
            ?? "\(library.loadedBatchCount)"
        return "\(library.loadingStep) · \(progress)"
    }

    private var footnoteText: String? {
        var parts: [String] = []
        if filter == .missing {
            let unchecked = library.uncheckedCount
            parts.append(
                unchecked > 0
                    ? "Includes \(unchecked.formatted()) unchecked photos and possible matches."
                    : "Includes possible matches.")
        }
        if selectedCategory != nil, unanalysedCount > 0 {
            parts.append("\(unanalysedCount.formatted()) photos not analysed yet")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            filterRow
            PhotoLibraryStatusRow(
                status: status, loadStepCaption: loadStepCaption,
                loadStartedAt: library.loadingStartedAt, reduceMotion: reduceMotion,
                barWidth: barWidth)
            if let footnoteText {
                Text(footnoteText).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.sm)
    }

    @ViewBuilder private var filterRow: some View {
        if showsCategories {
            // `ViewThatFits` measures each branch's ideal size and picks the first that fits the
            // available width. A horizontal `ScrollView` always reports an ideal width that
            // "fits" — it can scroll to show the rest of its content — so putting one in the wide
            // branch would make `ViewThatFits` pick that branch even when the chips visibly
            // overflow it. The wide branch below must stay a plain `HStack` so an actual overflow
            // is something `ViewThatFits` can measure and reject in favor of the stacked fallback.
            // That fallback is also what gives accessibility text sizes DESIGN.md's "content wraps
            // or stacks" for free: once the wide row no longer fits at a larger Dynamic Type size,
            // SwiftUI falls back automatically, with no size-class branch to maintain by hand.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: PorcelainTokens.Space.sm) {
                    filterPicker.fixedSize()
                    HStack(spacing: 6) { chips }
                    Spacer(minLength: 0)
                }
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    filterPicker
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) { chips }
                    }
                }
            }
        } else {
            filterPicker
        }
    }

    private var filterPicker: some View {
        Picker("Show", selection: $filter) {
            ForEach(PhotoLibraryFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("photos.filter")
        .help(
            "Not in Cubby includes unchecked photos and possible matches. More matches may appear while checking continues."
        )
    }

    @ViewBuilder private var chips: some View {
        ForEach(PhotoImportCatalog.categories, id: \.key) { category in
            CategoryChip(
                category: category, selected: selectedCategory?.key == category.key
            ) {
                selectedCategory = selectedCategory?.key == category.key ? nil : category
            }
        }
    }
}

/// The status row's own layout, taking a `PhotoLibraryStatus` value rather than reading
/// `PhotoLibraryHeader`'s live stores directly — every precedence case is then previewable from a
/// plain `PhotoLibraryStatus.derive(...)` call, with no `PhotoLibraryStore`/`PhotoMatchStore`
/// instance in sight. Not rendered at all when `status.text` is `nil`.
private struct PhotoLibraryStatusRow: View {
    let status: PhotoLibraryStatus
    let loadStepCaption: String?
    /// Paired with `loadStepCaption`: `Text(_:style: .timer)` re-renders itself once a second, which
    /// the old six-line block's `Elapsed:` line could not — it formatted `Date.now` inside an
    /// untracked getter, so it only ever moved when some *other* observed property happened to
    /// change, and read as frozen exactly when a stall made it worth reading.
    let loadStartedAt: Date?
    let reduceMotion: Bool
    let barWidth: CGFloat

    var body: some View {
        if let text = status.text {
            HStack(spacing: 6) {
                indicator
                Text(text).font(.caption).monospacedDigit().lineLimit(1)
                Spacer(minLength: 0)
                if let loadStepCaption {
                    HStack(spacing: PorcelainTokens.Space.xs) {
                        Text(loadStepCaption)
                        if let loadStartedAt { Text(loadStartedAt, style: .timer) }
                    }
                    .font(.porcelainCode)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("photos.loading.debug")
                }
            }
            .foregroundStyle(.secondary)
            // Store-driven changes (a scan progressing, an activity finishing) are unanimated by
            // default here — correct Reduce Motion behaviour — so no transition is attached to
            // this row's appearance/disappearance; only the determinate bar's own value below
            // animates, and only when Reduce Motion is off.
            .help(status.detail)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(text)
            .accessibilityValue(status.detail)
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    @ViewBuilder private var indicator: some View {
        switch status.indicator {
        case .none:
            EmptyView()
        case .indeterminate:
            ProgressView().controlSize(.small)
        case .determinate(let value):
            ProgressView(value: value)
                .frame(width: barWidth)
                .animation(reduceMotion ? nil : .default, value: value)
        case .warning:
            Image(systemName: "exclamationmark.triangle").foregroundStyle(PorcelainTokens.destructive)
        }
    }
}

/// One category filter chip. Moved out of `PhotoLibraryBrowser` (and out of `private`) so this
/// header can use it too; `PhotosRootView`'s "Category chips" preview moved down here with it.
struct CategoryChip: View {
    let category: PhotoCategory
    let selected: Bool
    let action: () -> Void

    private var tint: Color {
        let index = PhotoImportCatalog.categories.firstIndex { $0.key == category.key } ?? 0
        return PorcelainTokens.chartRamp[index % PorcelainTokens.chartRamp.count]
    }

    var body: some View {
        Button(action: action) {
            Text("\(category.emoji) \(category.label)")
        }
        .buttonStyle(.bordered)
        .tint(selected ? tint : nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

#Preview("Idle — one row", traits: .modifier(SignedInPreview())) {
    @Previewable @State var filter: PhotoLibraryFilter = .all
    @Previewable @State var category: PhotoCategory?
    PhotoLibraryHeader(
        filter: $filter, selectedCategory: $category, showsCategories: true, unanalysedCount: 0)
}

#Preview("Filter row — wide vs. compact", traits: .modifier(SignedInPreview())) {
    @Previewable @State var filter: PhotoLibraryFilter = .all
    @Previewable @State var category: PhotoCategory?
    VStack(alignment: .leading, spacing: 24) {
        Text("Wide (700pt)").font(.caption).foregroundStyle(.secondary)
        PhotoLibraryHeader(
            filter: $filter, selectedCategory: $category, showsCategories: true, unanalysedCount: 0
        )
        .frame(width: 700)
        .border(Color.secondary.opacity(0.3))
        Text("Compact (320pt)").font(.caption).foregroundStyle(.secondary)
        PhotoLibraryHeader(
            filter: $filter, selectedCategory: $category, showsCategories: true, unanalysedCount: 0
        )
        .frame(width: 320)
        .border(Color.secondary.opacity(0.3))
    }
    .padding()
}

/// Builds a `Slice` the same way `BackgroundActivityBar.swift`'s `previewModel` helper seeds a
/// whole `AppModel`, but scoped to a bare `BackgroundActivityCenter` — these previews exercise
/// `PhotoLibraryStatusRow` directly, so they need an activity slice, not a live app session.
private func previewSlice(_ activities: [BackgroundActivity]) -> BackgroundActivityCenter.Slice {
    let center = BackgroundActivityCenter()
    for activity in activities { _ = center.begin(activity) }
    return center.slice(BackgroundActivity.Kind.photoLibrary)
}

#Preview("Status — loading library") {
    PhotoLibraryStatusRow(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: true, indexIsLoading: false, hasIndex: false,
                indexError: nil, coverage: "Cubby has not been checked",
                scanStatus: "Loading your photo library…", activities: previewSlice([]))),
        loadStepCaption: "Reading local photos · 3 of 12", loadStartedAt: .now,
        reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Status — scanning + sweep running") {
    PhotoLibraryStatusRow(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: nil,
                coverage: "Checked 41 of 100 Cubby images. More matches may appear.",
                scanStatus: "Checking photo 41 of 100…",
                activities: previewSlice([
                    BackgroundActivity(
                        id: "photo-library-scan", kind: .libraryScan, title: "Scanning library",
                        phase: .running, progress: 0.41, detail: "41 of 100", startedAt: .now,
                        link: .localActivity("photo-library-scan"), isUserInitiated: false,
                        isCancellable: false),
                    BackgroundActivity(
                        id: "photo-classification-sweep", kind: .classificationSweep,
                        title: "Analysing photos", phase: .running, progress: 0.2, detail: "20 of 100",
                        startedAt: .now, link: .localActivity("photo-classification-sweep"),
                        isUserInitiated: false, isCancellable: false),
                ]))),
        loadStepCaption: nil, loadStartedAt: nil, reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Status — index error") {
    PhotoLibraryStatusRow(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: "Server error",
                coverage: "Cubby could not be refreshed. Showing previously known matches.",
                scanStatus: "142 of 200 library photos checked · 58 unchecked", activities: previewSlice([]))
        ), loadStepCaption: nil, loadStartedAt: nil, reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Status — automatic matching off") {
    PhotoLibraryStatusRow(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: false, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: nil, coverage: "Checked 100 Cubby images",
                scanStatus: "Automatic matching is off", activities: previewSlice([]))),
        loadStepCaption: nil, loadStartedAt: nil, reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Category chips") {
    HStack {
        ForEach(PhotoImportCatalog.categories, id: \.key) { category in
            CategoryChip(
                category: category, selected: category.key == PhotoImportCatalog.categories.first?.key
            ) {}
        }
    }
    .padding()
}
