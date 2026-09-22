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

/// One row per load stage, computed from plain inputs the same way `PhotoLibraryStatus.derive`
/// is — pure and unit-testable (`PhotoLibraryStatusTests`), previewable with no live store. Every
/// number it shows already exists on `PhotoLibraryStore`/`PhotoMatchStore`/
/// `PhotoClassificationSweep`; this only orders and captions them.
enum PhotoLibraryStages {
    enum State: Equatable {
        case done
        /// `value`/`total` are both `nil` for an indeterminate bar (a count isn't known yet).
        case running(value: Double?, total: Double?)
        /// An earlier stage in the sequence hasn't finished yet.
        case waiting
        case off(String)
        case failed(String)
    }

    struct Stage: Identifiable, Equatable {
        let id: String
        let label: String
        let state: State
        /// The "x of y" text, `nil` when there's nothing countable to show yet (an `.off` or a
        /// not-yet-started `.waiting` stage).
        let caption: String?
    }

    struct CategoriesInput: Equatable {
        let isRunning: Bool
        let analysedCount: Int
        let totalCount: Int
    }

    struct Inputs {
        // Local photos (PhotoKit enumeration).
        let loadedAssetCount: Int
        let totalAssetCount: Int?
        let isLoadingLibrary: Bool
        // Cubby index (the remote hash index refresh).
        let indexIsLoading: Bool
        let indexHasIndex: Bool
        let indexTotalCount: Int
        let indexRemainingCount: Int
        let indexError: String?
        // Match check (the on-device fingerprint scan against the Cubby index).
        let isParticipating: Bool
        let isScanning: Bool
        let scannedCount: Int
        let checkedCount: Int
        let libraryCount: Int
        // Categories (the on-device classification sweep). `nil` when the sweep itself doesn't
        // exist yet (`AppModel.photoClassificationSweep` before `preparePhotoSubsystem()` opens
        // the analysis store) — the row still shows, marked off, rather than shifting the others.
        let categories: CategoriesInput?
    }

    static func derive(_ inputs: Inputs) -> [Stage] {
        let local = localStage(inputs)
        let localDone = isDone(local.state)
        return [
            local, indexStage(inputs, localDone: localDone), matchStage(inputs, localDone: localDone),
            categoriesStage(inputs, localDone: localDone),
        ]
    }

    private static func isDone(_ state: State) -> Bool {
        if case .done = state { return true }
        return false
    }

    private static func localStage(_ inputs: Inputs) -> Stage {
        let caption =
            inputs.totalAssetCount.map {
                "\(inputs.loadedAssetCount.formatted()) of \($0.formatted()) photos"
            }
            ?? "\(inputs.loadedAssetCount.formatted()) photos"
        let state: State =
            inputs.isLoadingLibrary
            ? .running(
                value: Double(inputs.loadedAssetCount), total: inputs.totalAssetCount.map(Double.init))
            : .done
        return Stage(id: "local", label: "Local photos", state: state, caption: caption)
    }

    private static func indexStage(_ inputs: Inputs, localDone: Bool) -> Stage {
        let checkedSoFar = max(0, inputs.indexTotalCount - inputs.indexRemainingCount)
        let caption =
            inputs.indexHasIndex
            ? "\(checkedSoFar.formatted()) of \(inputs.indexTotalCount.formatted()) images" : nil
        let state: State
        if let indexError = inputs.indexError {
            state = .failed(indexError)
        } else if !localDone {
            state = .waiting
        } else if inputs.indexIsLoading {
            state =
                inputs.indexHasIndex
                ? .running(value: Double(checkedSoFar), total: Double(inputs.indexTotalCount))
                : .running(value: nil, total: nil)
        } else if inputs.indexHasIndex {
            state = .done
        } else if !inputs.isParticipating {
            // `refresh()` skips the remote index entirely when matching is off, so it would
            // otherwise sit in `.waiting` forever and the panel would never collapse.
            state = .off("Automatic matching is off")
        } else {
            state = .waiting
        }
        return Stage(id: "index", label: "Cubby index", state: state, caption: caption)
    }

    private static func matchStage(_ inputs: Inputs, localDone: Bool) -> Stage {
        guard inputs.isParticipating else {
            return Stage(
                id: "match", label: "Match check", state: .off("Automatic matching is off"), caption: nil)
        }
        guard localDone else {
            return Stage(id: "match", label: "Match check", state: .waiting, caption: nil)
        }
        let checkedNow = inputs.isScanning ? inputs.scannedCount : inputs.checkedCount
        let caption = "\(checkedNow.formatted()) of \(inputs.libraryCount.formatted()) photos"
        let state: State
        if inputs.isScanning {
            state = .running(value: Double(inputs.scannedCount), total: Double(inputs.libraryCount))
        } else if inputs.indexIsLoading || !inputs.indexHasIndex {
            state = .waiting
        } else {
            // A finished scan can leave photos unchecked for good (cloud-only originals it may
            // not download), so "done" means the scan ended, not `checkedCount == libraryCount`;
            // the caption keeps the true "x of y".
            state = .done
        }
        return Stage(id: "match", label: "Match check", state: state, caption: caption)
    }

    private static func categoriesStage(_ inputs: Inputs, localDone: Bool) -> Stage {
        guard inputs.isParticipating else {
            return Stage(
                id: "categories", label: "Categories", state: .off("Automatic matching is off"), caption: nil)
        }
        guard let categories = inputs.categories else {
            return Stage(
                id: "categories", label: "Categories", state: .off("Categories are unavailable"),
                caption: nil)
        }
        let caption = "\(categories.analysedCount.formatted()) of \(categories.totalCount.formatted()) photos"
        let state: State
        if !localDone {
            state = .waiting
        } else if categories.isRunning {
            state = .running(
                value: Double(categories.analysedCount), total: Double(categories.totalCount))
        } else if categories.analysedCount >= categories.totalCount {
            state = .done
        } else {
            // The sweep pauses (setting, thermal state, Low Power Mode, tab closed) and may not
            // resume this session; settled, so it never pins the panel open.
            state = .off("Not running")
        }
        return Stage(id: "categories", label: "Categories", state: state, caption: caption)
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

    private var stages: [PhotoLibraryStages.Stage] {
        PhotoLibraryStages.derive(
            PhotoLibraryStages.Inputs(
                loadedAssetCount: library.count,
                totalAssetCount: library.totalAssetCount,
                isLoadingLibrary: library.isLoadingLibrary,
                indexIsLoading: matches.isLoading,
                indexHasIndex: matches.hasIndex,
                indexTotalCount: matches.totalCount,
                indexRemainingCount: matches.remainingCount,
                indexError: matches.error,
                isParticipating: library.isParticipating,
                isScanning: library.isScanning,
                scannedCount: library.scannedCount,
                checkedCount: library.checked.count,
                libraryCount: library.count,
                categories: appModel.photoClassificationSweep.map {
                    PhotoLibraryStages.CategoriesInput(
                        isRunning: $0.isRunning, analysedCount: $0.analysedCount, totalCount: $0.totalCount)
                }))
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
            PhotoLibraryStagePanel(
                status: status, stages: stages, loadStartedAt: library.loadingStartedAt,
                reduceMotion: reduceMotion, barWidth: barWidth)
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

/// The stage panel's own layout, taking a `PhotoLibraryStatus` and a `[PhotoLibraryStages.Stage]`
/// rather than reading `PhotoLibraryHeader`'s live stores directly — every case is then
/// previewable from plain `derive(...)` calls, with no `PhotoLibraryStore`/`PhotoMatchStore`/
/// `PhotoClassificationSweep` instance in sight. Shows all four stage rows while any stage is
/// running or has failed; once every stage is done or off, it collapses to `status.text` — the
/// same one-line summary the old single-row status showed — behind a disclosure chevron.
private struct PhotoLibraryStagePanel: View {
    let status: PhotoLibraryStatus
    let stages: [PhotoLibraryStages.Stage]
    /// `Text(_:style: .timer)` re-renders itself once a second on the running Local row — unlike
    /// formatting `Date.now` in an untracked getter, which only moves when some *other* observed
    /// property happens to change, and reads as frozen exactly when a stall makes it worth reading.
    let loadStartedAt: Date?
    let reduceMotion: Bool
    let barWidth: CGFloat
    @State private var expanded = false

    private var allSettled: Bool {
        stages.allSatisfy {
            switch $0.state {
            case .done, .off: return true
            case .running, .waiting, .failed: return false
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            if allSettled, !expanded {
                collapsedRow
            } else {
                ForEach(stages) { stage in stageRow(stage) }
            }
            if allSettled {
                Button(expanded ? "Hide details" : "Show details") {
                    if reduceMotion { expanded.toggle() } else { withAnimation { expanded.toggle() } }
                }
                .buttonStyle(.plain)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("photos.stages.disclosure")
            }
        }
        // One combined element reading every visible stage's label/value, rather than one per
        // row — a VoiceOver user swiping past the header hears the whole picture at once.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    @ViewBuilder private var collapsedRow: some View {
        if let text = status.text {
            HStack(spacing: 6) {
                statusIndicator
                Text(text).font(.caption).monospacedDigit().lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .help(status.detail)
            .accessibilityLabel(text)
            .accessibilityValue(status.detail)
        }
    }

    @ViewBuilder private var statusIndicator: some View {
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

    private func stageRow(_ stage: PhotoLibraryStages.Stage) -> some View {
        HStack(spacing: 6) {
            stageGlyph(stage.state)
            Text(stage.label).font(.caption).lineLimit(1)
            Spacer(minLength: 0)
            trailingContent(for: stage)
        }
        .foregroundStyle(.secondary)
        .help(stageHelp(stage))
    }

    @ViewBuilder private func stageGlyph(_ state: PhotoLibraryStages.State) -> some View {
        switch state {
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .running(let value, let total):
            if let value, let total, total > 0 {
                ProgressView(value: value, total: total)
                    .frame(width: barWidth)
                    .animation(reduceMotion ? nil : .default, value: value)
            } else {
                ProgressView().controlSize(.small)
            }
        case .waiting:
            Image(systemName: "clock").foregroundStyle(.secondary)
        case .off:
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        case .failed:
            Image(systemName: "exclamationmark.triangle").foregroundStyle(PorcelainTokens.destructive)
        }
    }

    @ViewBuilder private func trailingContent(for stage: PhotoLibraryStages.Stage) -> some View {
        switch stage.state {
        case .off(let reason):
            Text(reason).font(.caption2).lineLimit(1)
        case .failed(let message):
            Text(message).font(.caption2).foregroundStyle(PorcelainTokens.destructive).lineLimit(1)
        default:
            if let caption = stage.caption {
                if stage.id == "local" {
                    HStack(spacing: PorcelainTokens.Space.xs) {
                        Text(caption).font(.caption).monospacedDigit()
                        if case .running = stage.state, let loadStartedAt {
                            Text(loadStartedAt, style: .timer).font(.caption)
                        }
                    }
                    .accessibilityIdentifier("photos.loading.debug")
                } else {
                    Text(caption).font(.caption).monospacedDigit()
                }
            }
        }
    }

    private func stageHelp(_ stage: PhotoLibraryStages.Stage) -> String {
        switch stage.state {
        case .done: return "\(stage.label): done" + (stage.caption.map { " (\($0))" } ?? "")
        case .running: return "\(stage.label): in progress" + (stage.caption.map { " (\($0))" } ?? "")
        case .waiting: return "\(stage.label): waiting"
        case .off(let reason): return "\(stage.label): \(reason)"
        case .failed(let message): return "\(stage.label): \(message)"
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
/// `PhotoLibraryStagePanel` directly, so they need an activity slice, not a live app session.
private func previewSlice(_ activities: [BackgroundActivity]) -> BackgroundActivityCenter.Slice {
    let center = BackgroundActivityCenter()
    for activity in activities { _ = center.begin(activity) }
    return center.slice(BackgroundActivity.Kind.photoLibrary)
}

#Preview("Stages — cold launch, mid-read") {
    PhotoLibraryStagePanel(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: true, indexIsLoading: false, hasIndex: false,
                indexError: nil, coverage: "Cubby has not been checked",
                scanStatus: "Loading your photo library…", activities: previewSlice([]))),
        stages: PhotoLibraryStages.derive(
            PhotoLibraryStages.Inputs(
                loadedAssetCount: 4_200, totalAssetCount: 90_112, isLoadingLibrary: true,
                indexIsLoading: false, indexHasIndex: false, indexTotalCount: 0, indexRemainingCount: 0,
                indexError: nil, isParticipating: true, isScanning: false, scannedCount: 0, checkedCount: 0,
                libraryCount: 4_200,
                categories: PhotoLibraryStages.CategoriesInput(
                    isRunning: false, analysedCount: 0, totalCount: 0))),
        loadStartedAt: .now, reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Stages — index error, local done") {
    PhotoLibraryStagePanel(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: "Server error",
                coverage: "Cubby could not be refreshed. Showing previously known matches.",
                scanStatus: "142 of 200 library photos checked · 58 unchecked", activities: previewSlice([]))
        ),
        stages: PhotoLibraryStages.derive(
            PhotoLibraryStages.Inputs(
                loadedAssetCount: 200, totalAssetCount: 200, isLoadingLibrary: false,
                indexIsLoading: false, indexHasIndex: true, indexTotalCount: 200, indexRemainingCount: 200,
                indexError: "Server error", isParticipating: true, isScanning: true, scannedCount: 142,
                checkedCount: 142, libraryCount: 200,
                categories: PhotoLibraryStages.CategoriesInput(
                    isRunning: true, analysedCount: 80, totalCount: 200))),
        loadStartedAt: nil, reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Stages — all done, collapsed") {
    PhotoLibraryStagePanel(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: true, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: nil, coverage: "Checked 100 Cubby images",
                scanStatus: "100 library photos checked", activities: previewSlice([]))),
        stages: PhotoLibraryStages.derive(
            PhotoLibraryStages.Inputs(
                loadedAssetCount: 100, totalAssetCount: 100, isLoadingLibrary: false,
                indexIsLoading: false, indexHasIndex: true, indexTotalCount: 100, indexRemainingCount: 0,
                indexError: nil, isParticipating: true, isScanning: false, scannedCount: 100,
                checkedCount: 100, libraryCount: 100,
                categories: PhotoLibraryStages.CategoriesInput(
                    isRunning: false, analysedCount: 100, totalCount: 100))),
        loadStartedAt: nil, reduceMotion: false, barWidth: 44
    )
    .padding()
}

#Preview("Stages — matching off") {
    PhotoLibraryStagePanel(
        status: .derive(
            PhotoLibraryStatus.Inputs(
                isParticipating: false, isLoadingLibrary: false, indexIsLoading: false, hasIndex: true,
                indexError: nil, coverage: "Checked 100 Cubby images",
                scanStatus: "Automatic matching is off", activities: previewSlice([]))),
        stages: PhotoLibraryStages.derive(
            PhotoLibraryStages.Inputs(
                loadedAssetCount: 100, totalAssetCount: 100, isLoadingLibrary: false,
                indexIsLoading: false, indexHasIndex: true, indexTotalCount: 100, indexRemainingCount: 0,
                indexError: nil, isParticipating: false, isScanning: false, scannedCount: 0, checkedCount: 0,
                libraryCount: 100, categories: nil)),
        loadStartedAt: nil, reduceMotion: false, barWidth: 44
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
