import CubbyKit
import Observation
import SwiftUI

/// Process-local cooking position. Closing a cover or leaving a recipe must not restart its method.
@Observable
final class RecipeCookingState {
    struct Request: Equatable {
        let id = UUID()
        let recipeID: String
        var step: Int?
    }

    @Observable
    final class Session: Identifiable {
        let id = UUID()
        let recipeID: String?
        let plan: RecipeCookPlan
        let factor: Double
        var index: Int

        init(recipeID: String?, plan: RecipeCookPlan, factor: Double, index: Int = 0) {
            self.recipeID = recipeID
            self.plan = plan
            self.factor = factor
            self.index = min(max(index, 0), max(plan.steps.count - 1, 0))
        }
    }

    var pending: Request?
    private(set) var session: Session?
    private var positions: [String: Int] = [:]

    func open(recipeID: String?, plan: RecipeCookPlan, factor: Double, step: Int? = nil) {
        close()
        pending = nil
        session = Session(
            recipeID: recipeID, plan: plan, factor: factor,
            index: step ?? recipeID.flatMap { positions[$0] } ?? 0)
    }

    func close() {
        if let session, let recipeID = session.recipeID { positions[recipeID] = session.index }
        session = nil
    }

    func reset() {
        pending = nil
        session = nil
        positions = [:]
    }
}

/// Transfers recipe identity and its zero-based pager index.
struct RecipeCookHandoff: Equatable {
    static let activityType = "com.nickysemenza.cubby.cook"
    let recipeID: String
    let step: Int

    init(recipeID: String, step: Int) {
        self.recipeID = recipeID
        self.step = step
    }

    init?(activity: NSUserActivity) {
        guard activity.activityType == Self.activityType,
            let recipeID = activity.userInfo?["recipeID"] as? String,
            EntityCatalog.descriptor(forShortcode: recipeID)?.key == .recipe,
            let step = activity.userInfo?["step"] as? Int, step >= 0
        else { return nil }
        self.init(recipeID: recipeID, step: step)
    }

    func update(_ activity: NSUserActivity, title: String) {
        activity.title = title
        activity.isEligibleForHandoff = true
        activity.isEligibleForSearch = false
        activity.isEligibleForPublicIndexing = false
        activity.userInfo = ["recipeID": recipeID, "step": step]
        activity.requiredUserInfoKeys = ["recipeID", "step"]
    }
}

/// One presenter for the workflow button, Shortcuts and Handoff, independent of detail-slot loading.
struct RecipeCookingPresentation: ViewModifier {
    @Environment(AppModel.self) private var model

    private var presented: Binding<RecipeCookingState.Session?> {
        Binding(get: { model.recipeCooking.session }, set: { if $0 == nil { model.recipeCooking.close() } })
    }

    func body(content: Content) -> some View {
        content
            #if os(iOS)
                .fullScreenCover(item: presented) { session in
                    RecipeCookModeView(session: session)
                }
            #else
                .sheet(item: presented) { session in
                    RecipeCookModeView(session: session)
                    .frame(minWidth: 500, minHeight: 600)
                }
            #endif
            .onContinueUserActivity(RecipeCookHandoff.activityType) { activity in
                guard let position = RecipeCookHandoff(activity: activity) else { return }
                model.recipeCooking.pending = .init(recipeID: position.recipeID, step: position.step)
            }
            .task(id: model.phase == .signedIn ? model.recipeCooking.pending : nil) {
                guard model.phase == .signedIn, let request = model.recipeCooking.pending else { return }
                let client = model.client
                do {
                    guard let row = try await client.row(EntityCatalog[.recipe], id: request.recipeID),
                        let plan = RecipeCookPlan(recipe: row.raw), !plan.steps.isEmpty
                    else { throw IntentContext.Failure.notFound("recipe with method steps") }
                    guard !Task.isCancelled, model.client === client,
                        model.recipeCooking.pending == request
                    else { return }
                    model.recipeCooking.open(recipeID: row.id, plan: plan, factor: 1, step: request.step)
                } catch {
                    guard !Task.isCancelled, model.client === client,
                        model.recipeCooking.pending == request
                    else { return }
                    model.recipeCooking.pending = nil
                    model.handle(error)
                }
            }
            .onChange(of: ObjectIdentifier(model.client)) { _, _ in model.recipeCooking.reset() }
            .onChange(of: model.phase) { _, phase in
                if phase == .signedOut { model.recipeCooking.reset() }
            }
    }
}
