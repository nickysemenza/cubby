import SwiftUI

struct PhotoAnalysisDisclosure: View {
    @Bindable var manifest: PhotoImportManifest
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                if manifest.analysisLog.isEmpty {
                    Text("Decision events will appear here as each photo is analyzed.")
                        .foregroundStyle(.secondary)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 10) {
                                ForEach(manifest.analysisLog) { entry in
                                    PhotoAnalysisLogRow(entry: entry)
                                        .id(entry.id)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .onAppear { scrollToLatest(proxy) }
                        .onChange(of: manifest.analysisLog.count) { _, _ in
                            scrollToLatest(proxy)
                        }
                    }
                    .frame(maxHeight: 220)
                    .accessibilityIdentifier("photos.analysis.log")
                }

                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    Label("Vision image classification", systemImage: "eye")
                    Label("Vision text recognition", systemImage: "text.viewfinder")
                    Label(
                        "Vision feature print",
                        systemImage: "point.3.connected.trianglepath.dotted")
                    Label("Capture metadata and date", systemImage: "calendar")
                    if let foundationModelSummary = manifest.foundationModelSummary {
                        Label(foundationModelSummary, systemImage: "apple.intelligence")
                    }
                    Text("No cloud AI is used. Derived analysis data syncs to Cubby.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.top, 8)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("On-device AI decision log")
                if let latest = manifest.analysisLog.last {
                    Text(latest.title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .font(.caption)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        guard let latest = manifest.analysisLog.last else { return }
        proxy.scrollTo(latest.id, anchor: .bottom)
    }
}

private struct PhotoAnalysisLogRow: View {
    let entry: PhotoAnalysisLogEntry

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 16)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(entry.title).fontWeight(.medium)
                    Spacer(minLength: 8)
                    Text(entry.timestamp.formatted(date: .omitted, time: .standard))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let detail = entry.detail {
                    Text(detail).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch entry.kind {
        case .progress: "clock"
        case .decision: "checkmark.circle.fill"
        case .abstention: "questionmark.circle"
        case .fallback: "arrow.triangle.branch"
        case .error: "exclamationmark.triangle.fill"
        }
    }

    private var color: Color {
        switch entry.kind {
        case .progress: .secondary
        case .decision: .green
        case .abstention, .fallback: .orange
        case .error: PorcelainTokens.destructive
        }
    }
}

struct PhotoAnalysisLogEntry: Identifiable, Equatable {
    enum Kind: Equatable {
        case progress
        case decision
        case abstention
        case fallback
        case error
    }

    let id: Int
    let timestamp: Date
    let photoID: String?
    let title: String
    let detail: String?
    let kind: Kind
}
