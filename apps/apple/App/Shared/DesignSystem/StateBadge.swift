import CubbyKit
import SwiftUI

/// One record state, drawn the same on a list row, a batch row and the detail header: the
/// declared `presentation.state` option with its reason or wait merged in. Needs-you, stalled and
/// failed are filled pills; running, queued, paused, done and ended are a mark and a label. The
/// label always carries the state, so colour is never its only channel.
struct StateBadge: View {
    enum Size { case row, header }

    let state: RecordState
    var size: Size = .row
    /// Muted text after the label; nil keeps the state's own reason or wait.
    var trailing: String?? = nil

    private var trailingText: String? { trailing ?? state.trailing }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                main
                if let trailingText {
                    Text(trailingText)
                        .font(size == .header ? .subheadline : .caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(size == .header ? nil : 1)
                        .fixedSize(horizontal: false, vertical: size == .header)
                        .truncationMode(.tail)
                }
            }
            if size == .header, let jobs = state.jobs {
                Text("Live Jobs: \(jobs)").font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var main: some View {
        let font = size == .header ? Font.subheadline.weight(.semibold) : Font.caption.weight(.semibold)
        switch state.role {
        case .needs:
            pill(fill: FieldGuideTokens.Work.needs, ink: FieldGuideTokens.Work.needsInk, font: font) {
                RoundedRectangle(cornerRadius: 1.5).fill(FieldGuideTokens.Work.needsInk)
                    .frame(width: 7, height: 7)
            }
        case .stalled:
            pill(
                fill: FieldGuideTokens.Work.stalledMark.opacity(0.18), ink: FieldGuideTokens.Work.stalled,
                font: font
            ) {
                Image(systemName: "exclamationmark.triangle.fill").imageScale(.small)
            }
        case .failed:
            pill(
                fill: FieldGuideTokens.Work.failed.opacity(0.14), ink: FieldGuideTokens.Work.failed,
                font: font
            ) {
                Image(systemName: "xmark").imageScale(.small).fontWeight(.bold)
            }
        case .running, .queued, .paused, .done, .ended:
            HStack(spacing: 5) {
                mark
                Text(state.label).foregroundStyle(labelColor)
            }
            .font(size == .header ? .subheadline.weight(.medium) : .caption.weight(.medium))
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var mark: some View {
        switch state.role {
        case .paused:
            Image(systemName: "pause.fill").imageScale(.small).foregroundStyle(FieldGuideTokens.Work.paused)
        case .queued:
            Circle().strokeBorder(FieldGuideTokens.Work.queued, lineWidth: 1.5).frame(width: 8, height: 8)
        default:
            Circle().fill(labelColor == .secondary ? Color.secondary : labelColor).frame(width: 8, height: 8)
        }
    }

    private var labelColor: Color {
        switch state.role {
        case .running: FieldGuideTokens.Work.running
        case .done: FieldGuideTokens.Work.done
        default: .secondary
        }
    }

    private func pill<Mark: View>(
        fill: Color, ink: Color, font: Font, @ViewBuilder mark: () -> Mark
    ) -> some View {
        HStack(spacing: 5) {
            mark()
            Text(state.label)
        }
        .font(font)
        .foregroundStyle(ink)
        .padding(.horizontal, size == .header ? 8 : 6)
        .padding(.vertical, size == .header ? 3 : 2)
        .background(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusChip).fill(fill))
        .fixedSize(horizontal: false, vertical: true)
    }
}

#Preview("State badges") {
    let states: [RecordState] = [
        .init(
            option: .init(value: "paused_review", label: "Needs review", phase: .needs),
            reason: "2 orders to confirm",
            waitReason: nil, waitLabel: nil, jobs: nil, stalled: false),
        .init(
            option: .init(value: "running", label: "Running"), reason: nil, waitReason: "queued",
            waitLabel: "Queued · 3rd of 9 · about 4 min", jobs: "9 queued", stalled: false),
        .init(
            option: .init(value: "running", label: "Running"), reason: nil, waitReason: nil, waitLabel: nil,
            jobs: nil, stalled: true),
        .init(
            option: .init(value: "failed", label: "Failed", color: "var(--destructive)", phase: .finished),
            reason: "Vendor sign-in expired", waitReason: nil, waitLabel: nil, jobs: nil, stalled: false),
        .init(
            option: .init(value: "completed", label: "Completed", color: "var(--positive)", phase: .finished),
            reason: nil, waitReason: nil, waitLabel: nil, jobs: nil, stalled: false),
    ]
    VStack(alignment: .leading, spacing: 12) {
        ForEach(states, id: \.self) { StateBadge(state: $0) }
        StateBadge(state: states[1], size: .header)
    }
    .padding()
}
