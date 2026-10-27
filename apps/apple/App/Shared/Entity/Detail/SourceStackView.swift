import CubbyKit
import SwiftUI

/// One ordered evidence chain (web `SourceStack`): a rail with one node per level, the deciding
/// level filled and emphasized, a blocked level outlined in the warning color. Each level's title
/// opens its source record when it names one; the caller supplies the level's field content.
/// Reference chains, resolution evidence and display-image chains all draw through this view.
struct SourceStackView<Content: View>: View {
    let label: String
    let levels: [SourceStackLevel]
    var showsTitles = true
    @ViewBuilder let content: (SourceStackLevel) -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(levels.enumerated()), id: \.element.id) { position, level in
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                    rail(level.status, first: position == 0, last: position == levels.count - 1)
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        if showsTitles { title(level) }
                        content(level)
                    }
                    .padding(.vertical, FieldGuideTokens.Space.xs)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(
                    showsTitles ? "\(level.title), \(level.status.label)" : level.status.label)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func title(_ level: SourceStackLevel) -> some View {
        let emphasis: Font = level.status == .deciding ? .callout.weight(.semibold) : .callout
        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.xs) {
            if let target = level.target {
                NavigationLink(value: Route.entityDetail(target.entity, id: target.id)) {
                    Text(level.title).font(emphasis).multilineTextAlignment(.leading)
                }
                .buttonStyle(.borderless)
            } else {
                Text(level.title).font(emphasis)
                    .foregroundStyle(level.status == .deciding ? .primary : .secondary)
            }
            if case .unsupported = level.status {
                Text(level.status.label).font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func rail(_ status: SourceStackLevel.Status, first: Bool, last: Bool) -> some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Rectangle().fill(first ? .clear : FieldGuideTokens.hairline).frame(width: 1, height: 10)
                Rectangle().fill(last ? .clear : FieldGuideTokens.hairline).frame(width: 1)
            }
            Circle()
                .fill(status == .deciding ? FieldGuideTokens.graphite : Color.clear)
                .overlay {
                    Circle().strokeBorder(
                        status == .blocked
                            ? FieldGuideTokens.destructive : FieldGuideTokens.graphiteSecondary,
                        lineWidth: 1)
                }
                .frame(width: 8, height: 8)
                .padding(.top, 6)
        }
        .frame(width: 12)
        .accessibilityHidden(true)
    }
}

/// A display-image level's images, view only. The chosen cover carries an outline and a caption.
struct SourceStackImageStrip: View {
    struct Item: Identifiable, Hashable {
        let id: String
        let url: URL?
        let chosen: Bool
    }

    let label: String
    let images: [Item]

    var body: some View {
        if images.isEmpty {
            Text("No images").font(.caption).foregroundStyle(.secondary)
        } else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                    ForEach(images) { image in
                        VStack(spacing: 2) {
                            Thumb(url: image.url, size: 64)
                                .overlay {
                                    if image.chosen {
                                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                                            .strokeBorder(FieldGuideTokens.info, lineWidth: 2)
                                    }
                                }
                            if image.chosen {
                                Text("Cover").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(image.chosen ? "Chosen cover" : "\(label) image")
                    }
                }
                .padding(2)
            }
            .scrollIndicators(.hidden)
        }
    }
}

#Preview("Source stack") {
    NavigationStack {
        SourceStackView(
            label: "Resolution order",
            levels: [
                .init(
                    id: "0", index: 0, status: .skipped, title: "This record", target: nil),
                .init(
                    id: "1", index: 1, status: .blocked, title: "Fixture order",
                    target: .init(entity: .purchase, id: "PUR-4K7M")),
                .init(
                    id: "2", index: 2, status: .deciding, title: "Synthetic vendor",
                    target: .init(entity: .vendor, id: "VEN-4K7M")),
                .init(
                    id: "3", index: 3, status: .unsupported("future_effect"), title: "Default", target: nil),
            ]
        ) { level in
            Text("Level \(level.index) value").font(.caption).foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview("Image strip") {
    SourceStackImageStrip(
        label: "Own",
        images: [
            .init(id: "IMG-4K7M", url: nil, chosen: true), .init(id: "IMG-7M4K", url: nil, chosen: false),
        ]
    )
    .padding()
}
