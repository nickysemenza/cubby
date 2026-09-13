import CubbyKit
import SwiftUI

/// Works down the products that have no photo, one product at a time.
struct NeedsPhotoView: View {
    let locationID: LocationCode?

    @Environment(AppModel.self) private var model
    @State private var needs: NeedsPhotoModel?
    @State private var capture: PhotoCaptureModel?

    var body: some View {
        Group {
            if let needs {
                content(needs)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .porcelainScreen()
        .navigationTitle("Needs a photo")
        .task(id: model.host) {
            let needs = NeedsPhotoModel(client: model.client, locationID: locationID)
            self.needs = needs
            await needs.load()
        }
        .refreshControl { await needs?.load() }
        .sheet(item: $capture) { capture in
            AddPhotoSheet(capture: capture) { _ in needs?.photoAdded() }
        }
    }

    @ViewBuilder
    private func content(_ needs: NeedsPhotoModel) -> some View {
        switch needs.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView(
                "Couldn't load the queue", systemImage: "exclamationmark.triangle", description: Text(message)
            )
        case .ready:
            ScrollView {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                    header(needs)
                    if let row = needs.current {
                        productPanel(row)
                        LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                            Button {
                                capture = PhotoCaptureModel(
                                    client: model.client, entity: .product, entityID: row.id,
                                    entityTitle: row.title,
                                    featurePrints: model.featurePrints
                                )
                            } label: {
                                ActionTile(
                                    title: "Add photo", symbol: "camera.badge.ellipsis",
                                    detail: "Lift the subject and upload")
                            }
                            .buttonStyle(.plain)
                            Button {
                                needs.skip()
                            } label: {
                                ActionTile(title: "Skip", symbol: "forward", detail: "Come back later")
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        Panel {
                            Text(
                                needs.added > 0 || needs.skipped > 0
                                    ? "That's the end of the queue." : "Every product has a photo."
                            )
                            .font(.porcelainTitle)
                            .foregroundStyle(PorcelainTokens.graphite)
                            Text("\(needs.added) added · \(needs.skipped) skipped")
                                .font(.porcelainData)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                    }
                }
                .padding(PorcelainTokens.Space.lg)
                .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func header(_ needs: NeedsPhotoModel) -> some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Eyebrow(locationID == nil ? "Every product" : "In this location")
            Text(needs.total.map { "\($0) without a photo" } ?? "Products without a photo")
                .font(.porcelainData)
                .foregroundStyle(PorcelainTokens.graphite)
        }
    }

    private func productPanel(_ row: EntityRow) -> some View {
        Panel {
            HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
                DomainMark(.house)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                    Text(row.title)
                        .font(.porcelainTitle)
                        .foregroundStyle(PorcelainTokens.graphite)
                    if let subtitle = row.subtitle {
                        Text(subtitle)
                            .font(.porcelainBody)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                    Text(row.id)
                        .font(.porcelainData)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Spacer(minLength: 0)
            }
            NavigationLink(value: Route.entityDetail(.product, id: row.id)) {
                Label("Open product", systemImage: "arrow.up.right.square")
                    .font(.porcelainLabel)
            }
        }
    }
}

extension PhotoCaptureModel: Identifiable {
    var id: String { "\(entity.rawValue)/\(entityID)" }
}

#Preview {
    NavigationStack {
        NeedsPhotoView(locationID: nil)
    }
    .environment(PreviewFixtures.signedInModel())
}
