import SwiftUI

struct DraftDismissalState {
    enum Confirmation: Equatable {
        case discardChanges
        case closeWhileSaving
    }

    fileprivate(set) var confirmation: Confirmation?

    mutating func request(isDirty: Bool, isSaving: Bool, dismiss: DismissAction) {
        request(isDirty: isDirty, isSaving: isSaving) { dismiss() }
    }

    mutating func request(
        isDirty: Bool, isSaving: Bool, onDismiss: @escaping () -> Void
    ) {
        if isSaving {
            confirmation = .closeWhileSaving
        } else if isDirty {
            confirmation = .discardChanges
        } else {
            onDismiss()
        }
    }

    mutating func request(isDirty: Bool, dismiss: DismissAction) {
        request(isDirty: isDirty, isSaving: false, dismiss: dismiss)
    }

    mutating func request(isDirty: Bool, onDiscard: @escaping () -> Void) {
        request(isDirty: isDirty, isSaving: false, onDismiss: onDiscard)
    }
}

extension View {
    /// Blocks gesture dismissal while a draft is changed or saving. Cancel remains available so
    /// the user can explicitly discard a changed draft or close an editor while its write finishes.
    func draftDismissal(
        _ state: Binding<DraftDismissalState>, isDirty: Bool, isSaving: Bool,
        onDiscard: @escaping () -> Void,
        onCloseWhileSaving: @escaping () -> Void
    ) -> some View {
        interactiveDismissDisabled(isDirty || isSaving)
            .confirmationDialog(
                state.wrappedValue.confirmation == .closeWhileSaving
                    ? "Close editor while saving?" : "Discard unsaved changes?",
                isPresented: confirmationBinding(state),
                titleVisibility: .visible
            ) {
                if state.wrappedValue.confirmation == .closeWhileSaving {
                    Button("Close Editor", role: .destructive, action: onCloseWhileSaving)
                    Button("Keep Editor Open", role: .cancel) {}
                } else {
                    Button("Discard Changes", role: .destructive, action: onDiscard)
                    Button("Keep Editing", role: .cancel) {}
                }
            } message: {
                if state.wrappedValue.confirmation == .closeWhileSaving {
                    Text("The save will continue and may still complete.")
                }
            }
    }

    func draftDismissal(
        _ state: Binding<DraftDismissalState>, isDirty: Bool, isSaving: Bool,
        onDiscard: @escaping () -> Void
    ) -> some View {
        draftDismissal(
            state, isDirty: isDirty, isSaving: isSaving,
            onDiscard: onDiscard, onCloseWhileSaving: onDiscard)
    }

    private func confirmationBinding(_ state: Binding<DraftDismissalState>) -> Binding<Bool> {
        Binding(
            get: { state.wrappedValue.confirmation != nil },
            set: { isPresented in
                guard !isPresented else { return }
                state.wrappedValue.confirmation = nil
            })
    }
}
