import SwiftUI

struct DraftDismissalState {
    enum Confirmation: Equatable {
        case discardChanges
    }

    fileprivate(set) var confirmation: Confirmation?

    mutating func request(isDirty: Bool, isSaving: Bool, dismiss: DismissAction) {
        request(isDirty: isDirty, isSaving: isSaving) { dismiss() }
    }

    mutating func request(
        isDirty: Bool, isSaving: Bool, onDismiss: @escaping () -> Void
    ) {
        guard !isSaving else { return }
        if isDirty {
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
    /// Blocks dismissal during writes. Editors can opt into the system's dirty-draft dismissal
    /// dialog for gestures; explicit Cancel requests share the same wording and discard action.
    func draftDismissal(
        _ state: Binding<DraftDismissalState>, isDirty: Bool, isSaving: Bool,
        title: String = "Discard unsaved changes?", confirmInteractiveDismissal: Bool = false,
        onDiscard: @escaping () -> Void
    ) -> some View {
        interactiveDismissDisabled(isSaving || (isDirty && !confirmInteractiveDismissal))
            .dismissalConfirmationDialog(
                title, shouldPresent: confirmInteractiveDismissal && isDirty && !isSaving
            ) {
                // SwiftUI completes the pending dismissal after a non-cancel action.
                Button("Discard Changes", role: .destructive) {}
                Button("Keep Editing", role: .cancel) {}
            }
            .confirmationDialog(
                title,
                isPresented: confirmationBinding(state),
                titleVisibility: .visible
            ) {
                Button("Discard Changes", role: .destructive, action: onDiscard)
                Button("Keep Editing", role: .cancel) {}
            }
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
