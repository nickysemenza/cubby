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
    /// Blocks gesture, Escape, and Cancel dismissal while a write is in flight. A failed write
    /// leaves the draft in place, where Cancel can still offer an explicit discard.
    func draftDismissal(
        _ state: Binding<DraftDismissalState>, isDirty: Bool, isSaving: Bool,
        onDiscard: @escaping () -> Void
    ) -> some View {
        interactiveDismissDisabled(isDirty || isSaving)
            .confirmationDialog(
                "Discard unsaved changes?",
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
