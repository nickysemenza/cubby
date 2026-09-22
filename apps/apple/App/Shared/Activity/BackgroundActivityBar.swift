import CubbyKit
import SwiftUI

/// The iOS `.tabViewBottomAccessory` content: one button surfacing whatever this device is doing
/// right now, adapting to `.inline` (alongside the minimized tab bar) and `.expanded` (its own
/// row above the tab bar) per `axiom-swiftui`'s Dynamic Bottom Accessory guidance. Tapping opens
/// the single running activity's own detail, or the Activity list when several are running at
/// once (`Navigator.openActivity(_:)` treats `nil` the same as "more than one").
struct BackgroundActivityBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var visible: [BackgroundActivity] { model.backgroundActivity.visibleActivities }
    private var primary: BackgroundActivity? { model.backgroundActivity.primary }
    private var aggregateProgress: Double? { model.backgroundActivity.aggregateProgress }

    private var targetLink: BackgroundActivity.Link? {
        visible.count == 1 ? visible.first?.link : nil
    }

    var body: some View {
        if let primary {
            Button {
                model.navigator.openActivity(targetLink)
            } label: {
                switch placement {
                case .inline: inlineLabel(primary)
                default: expandedLabel(primary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityLabel(primary))
            .accessibilityHint("Opens Activity")
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    @ViewBuilder private func inlineLabel(_ primary: BackgroundActivity) -> some View {
        Label(primary.title, systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.medium))
            .lineLimit(1)
    }

    @ViewBuilder private func expandedLabel(_ primary: BackgroundActivity) -> some View {
        HStack(spacing: 10) {
            progressIndicator
            VStack(alignment: .leading, spacing: 2) {
                Text(primary.title).font(.subheadline.weight(.medium)).lineLimit(1)
                if visible.count > 1 {
                    Text("\(visible.count) tasks")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder private var progressIndicator: some View {
        if let aggregateProgress {
            ProgressView(value: aggregateProgress)
                .frame(width: 28)
                .animation(reduceMotion ? nil : .default, value: aggregateProgress)
        } else {
            ProgressView().frame(width: 28)
        }
    }

    private func accessibilityLabel(_ primary: BackgroundActivity) -> String {
        var parts = [visible.count == 1 ? "1 background task" : "\(visible.count) background tasks"]
        parts.append(primary.title.lowercased())
        if let aggregateProgress {
            parts.append("\(Int((aggregateProgress * 100).rounded())) percent")
        }
        return parts.joined(separator: ", ")
    }
}

extension BackgroundActivity {
    fileprivate static let previewScan = BackgroundActivity(
        id: "photo-library-scan", kind: .libraryScan, title: "Scanning library", phase: .running,
        progress: 0.41, detail: "41 of 100", startedAt: .now,
        link: .localActivity("photo-library-scan"), isUserInitiated: false, isCancellable: false)
    fileprivate static let previewUpload = BackgroundActivity(
        id: "upload", kind: .upload, title: "Adding photos", phase: .running, progress: nil,
        detail: nil, startedAt: .now, link: .localActivity("upload"), isUserInitiated: true,
        isCancellable: false)
}

/// Kept outside the `#Preview` macro bodies below: a model built and seeded inline made the type
/// checker choke ("failed to produce diagnostic for expression") on this file.
private func previewModel(_ activities: [BackgroundActivity]) -> AppModel {
    let model = PreviewFixtures.signedInModel()
    for activity in activities { _ = model.backgroundActivity.begin(activity) }
    return model
}

#if os(iOS)
    /// `TabViewBottomAccessoryPlacement` is system-supplied (its environment key path is read-only
    /// — `.environment(\.tabViewBottomAccessoryPlacement, .expanded)` does not compile), so
    /// previewing both the inline and expanded appearances means hosting the bar in a real
    /// `TabView` accessory, as `RootTabsView` does, rather than forcing the placement directly.
    /// `.tabViewBottomAccessory` itself is iOS-only, which is why this preview — unlike the view
    /// it previews — is `#if os(iOS)`: `BackgroundActivityBar` lives in `App/Shared` because
    /// nothing else about it is iOS-specific, but this is its only real host.
    #Preview("In a TabView") {
        TabView {
            Tab("Today", systemImage: "sun.horizon") { Text("Today") }
            Tab("Photos", systemImage: "photo.on.rectangle.angled") { Text("Photos") }
        }
        .tabViewBottomAccessory { BackgroundActivityBar() }
        .environment(previewModel([.previewScan, .previewUpload]))
    }
#endif
