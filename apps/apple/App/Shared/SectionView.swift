import CubbyKit
import SwiftUI

/// Routes a top-level section to its screen and owns the shared `Route` destinations, so the
/// iOS tab stacks and the macOS detail column resolve pushes identically.
struct SectionView: View {
    let section: AppSection

    var body: some View {
        Group {
            switch section {
            case .today: TodayView()
            case .capture: CaptureView()
            case .browse: BrowseRootView()
            case .identify: IdentifyView()
            case .dev: DevView()
            }
        }
        .navigationDestination(for: Route.self) { route in
            switch route {
            case .entityList(let key): EntityListView(key: key)
            case .entityDetail(let key, let id): EntityDetailView(key: key, id: id)
            }
        }
    }
}

/// The landing screen: where this app is pointed, what it can do from here, and an honest note
/// about what does not exist yet. No counts are invented — the PoC has no Today payload to read.
struct TodayView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.sectionSelection) private var sectionSelection

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                Eyebrow(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))

                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("Session")
                    Panel(padding: 0, spacing: 0) {
                        LabeledRow(label: "Host", value: model.host, mono: true)
                        PanelDivider()
                        LabeledRow(
                            label: "Signed in",
                            value: model.phase == .signedIn ? "Yes" : "No",
                            tone: model.phase == .signedIn
                                ? PorcelainTokens.positive : PorcelainTokens.graphiteSecondary
                        )
                        PanelDivider()
                        LabeledRow(label: "Credential", value: model.credentialSummary)
                    }
                }

                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("Shortcuts")
                    LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                        NavigationLink(value: Route.entityList(.product)) {
                            ActionTile(
                                title: "Browse products",
                                symbol: "shippingbox",
                                detail: "Catalog and stock"
                            )
                        }
                        .buttonStyle(.plain)

                        shortcut(
                            to: .capture,
                            title: "Capture",
                            symbol: "barcode.viewfinder",
                            detail: "Sweep a location"
                        )
                        shortcut(
                            to: .identify,
                            title: "Identify",
                            symbol: "camera.metering.center.weighted",
                            detail: "Rank a photo"
                        )
                        shortcut(
                            to: .dev,
                            title: "Dev",
                            symbol: "wrench.and.screwdriver",
                            detail: "Parser and API"
                        )
                    }
                }

                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("Coming next")
                    Panel {
                        Text(
                            "Tasks due, meals planned, open problems, and pantry about to expire land here. Until they do, Today only reports the session and the ways in."
                        )
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
        .navigationTitle("Today")
    }

    /// A tile that moves the shell's selection. Without a shell (previews) there is nothing to
    /// move, so the tile stays inert rather than pretending to navigate.
    @ViewBuilder
    private func shortcut(
        to section: AppSection,
        title: String,
        symbol: String,
        detail: String
    ) -> some View {
        Button {
            sectionSelection?.wrappedValue = section
        } label: {
            ActionTile(title: title, symbol: symbol, detail: detail)
        }
        .buttonStyle(.plain)
        .disabled(sectionSelection == nil)
    }
}

#Preview {
    NavigationStack { TodayView() }.environment(PreviewFixtures.signedInModel())
}
