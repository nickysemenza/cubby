import CubbyKit
import SwiftUI

/// The real native List and Detail screens for each `EntityScreenFixture`. `#Preview`s and
/// `PreviewRenderTests` (`pnpm apple previews`) share this catalog, so a named
/// preview and its rendered PNG are the same view with the same data.
enum EntityScreenPreview: String, CaseIterable, Identifiable, Sendable {
    case productList = "product-list"
    case productDetail = "product-detail"
    case expenseList = "expense-list"
    case expenseDetail = "expense-detail"
    case taskList = "task-list"
    case taskDetail = "task-detail"

    var id: String { rawValue }

    var fixture: EntityScreenFixture {
        switch self {
        case .productList, .productDetail: .product
        case .expenseList, .expenseDetail: .expense
        case .taskList, .taskDetail: .task
        }
    }

    var isDetail: Bool {
        switch self {
        case .productDetail, .expenseDetail, .taskDetail: true
        case .productList, .expenseList, .taskList: false
        }
    }
}

/// The appearance sweep every screen renders in: light, dark, and one accessibility text size.
enum PreviewAppearance: String, CaseIterable, Identifiable, Sendable {
    case light, dark, accessibility

    var id: String { rawValue }
    var colorScheme: ColorScheme { self == .dark ? .dark : .light }
    var dynamicTypeSize: DynamicTypeSize { self == .accessibility ? .accessibility3 : .large }
}

/// Loads a screen's fixture rows into the same models the live screens use (list paging and
/// relation sections through injected `EntityListPageSource`s), so the first rendered frame is the
/// loaded state and no read reaches the blocked preview network.
@MainActor
@Observable
final class EntityScreenPreviewModel {
    let screen: EntityScreenPreview
    let appModel: AppModel
    private(set) var list: GenericEntityListModel?
    private(set) var detail: GenericEntityDetailModel?
    private(set) var relationSections: [RelationSectionModel] = []

    init(screen: EntityScreenPreview) {
        self.screen = screen
        appModel = PreviewFixtures.signedInModel()
    }

    var isReady: Bool { list != nil || detail != nil }

    func prepare() async {
        guard !isReady else { return }
        let fixture = screen.fixture
        if screen.isDetail {
            let row = fixture.detailRow
            PreviewOperationResponses.register(
                fixture: "\(fixture.rawValue)DetailReads", recordID: row.id,
                suggestions: fixture == .product ? PreviewFixtures.productSuggestions : nil)
            let pages = fixture.relationPages
            let sections = RelationSectionModel.sections(
                of: fixture.descriptor, recordID: row.id, client: appModel.client)
            for section in sections {
                let page = pages[section.id] ?? Self.emptyPage
                await section.list.setSource(Self.source("\(screen.id).\(section.id)", page))
            }
            relationSections = sections
            detail = GenericEntityDetailModel(
                descriptor: fixture.descriptor, client: appModel.client, loaded: row)
        } else {
            let model = GenericEntityListModel(
                descriptor: fixture.descriptor, client: appModel.client,
                source: Self.source(screen.id, fixture.listPage))
            await model.loadInitial()
            list = model
        }
    }

    private static let emptyPage = ListPage<EntityRow>(
        items: [], meta: ListPageMeta(pageIndex: 1, pageSize: 50, totalCount: 0, hasNextPage: false))

    private static func source(_ id: String, _ page: ListPage<EntityRow>) -> EntityListPageSource {
        EntityListPageSource(id: id) { _ in page }
    }
}

/// One catalog screen in one appearance. Pass a prepared model to render synchronously.
struct EntityScreenPreviewHost: View {
    @State private var model: EntityScreenPreviewModel
    let appearance: PreviewAppearance

    init(_ screen: EntityScreenPreview, appearance: PreviewAppearance = .light) {
        let model = EntityScreenPreviewModel(screen: screen)
        _model = State(initialValue: model)  // state-init-ok: constant synthetic preview fixture
        self.appearance = appearance
    }

    init(prepared model: EntityScreenPreviewModel, appearance: PreviewAppearance) {
        _model = State(initialValue: model)  // state-init-ok: constant synthetic preview fixture
        self.appearance = appearance
    }

    var body: some View {
        NavigationStack {
            screen
        }
        .environment(model.appModel)
        .preferredColorScheme(appearance.colorScheme)
        .environment(\.dynamicTypeSize, appearance.dynamicTypeSize)
        .task { await model.prepare() }
    }

    @ViewBuilder private var screen: some View {
        let fixture = model.screen.fixture
        if let list = model.list {
            EntityListView(key: fixture.key, model: list)
        } else if let detail = model.detail {
            // The real screen: toolbar, action bar under the hero and More all render.
            EntityDetailView(loaded: detail, relationSections: model.relationSections)
        } else {
            ProgressView()
        }
    }
}

#Preview("Product list") { EntityScreenPreviewHost(.productList) }
#Preview("Product list · dark") { EntityScreenPreviewHost(.productList, appearance: .dark) }
#Preview("Product list · accessibility") { EntityScreenPreviewHost(.productList, appearance: .accessibility) }
#Preview("Product detail") { EntityScreenPreviewHost(.productDetail) }
#Preview("Product detail · dark") { EntityScreenPreviewHost(.productDetail, appearance: .dark) }
#Preview("Product detail · accessibility") {
    EntityScreenPreviewHost(.productDetail, appearance: .accessibility)
}
#Preview("Expense list") { EntityScreenPreviewHost(.expenseList) }
#Preview("Expense list · dark") { EntityScreenPreviewHost(.expenseList, appearance: .dark) }
#Preview("Expense list · accessibility") { EntityScreenPreviewHost(.expenseList, appearance: .accessibility) }
#Preview("Expense detail") { EntityScreenPreviewHost(.expenseDetail) }
#Preview("Expense detail · dark") { EntityScreenPreviewHost(.expenseDetail, appearance: .dark) }
#Preview("Expense detail · accessibility") {
    EntityScreenPreviewHost(.expenseDetail, appearance: .accessibility)
}
#Preview("Task list") { EntityScreenPreviewHost(.taskList) }
#Preview("Task list · dark") { EntityScreenPreviewHost(.taskList, appearance: .dark) }
#Preview("Task list · accessibility") { EntityScreenPreviewHost(.taskList, appearance: .accessibility) }
#Preview("Task detail") { EntityScreenPreviewHost(.taskDetail) }
#Preview("Task detail · dark") { EntityScreenPreviewHost(.taskDetail, appearance: .dark) }
#Preview("Task detail · accessibility") { EntityScreenPreviewHost(.taskDetail, appearance: .accessibility) }
