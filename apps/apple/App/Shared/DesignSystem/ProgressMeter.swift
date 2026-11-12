import CubbyKit
import SwiftUI

/// How far work has come, drawn from a `ProgressValue`'s counts alone: a total of 12 or fewer as
/// one segment per unit, a larger one as a proportional bar, and an unknown total as a dashed
/// indeterminate track. `row` is a 40×5 track beside its label; `block` a full-width track over
/// it. Hollow always means queued.
struct ProgressMeter: View {
    enum Variant { case row, block }

    let value: ProgressValue
    var note: String? = nil
    var variant: Variant = .block
    /// Draws completed work in the paused colour.
    var paused = false
    var showsLabel = true

    private var title: String { [value.label, note].compactMap { $0 }.joined(separator: " · ") }

    var body: some View {
        let layout =
            variant == .row
            ? AnyLayout(HStackLayout(spacing: FieldGuideTokens.Space.sm))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 5))
        layout {
            track
                .frame(width: variant == .row ? 40 : nil, height: variant == .row ? 5 : 6)
                .frame(maxWidth: variant == .row ? nil : .infinity)
            if showsLabel {
                Text(title)
                    .font(variant == .row ? .caption : .subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(value.total == nil ? "\(title), total unknown" : title)
    }

    private var track: some View {
        let track = value.track
        let done = paused ? FieldGuideTokens.Work.paused : FieldGuideTokens.Work.progressDone
        let colors: [ProgressValue.UnitState: Color] = [
            .done: done, .active: FieldGuideTokens.Work.running, .failed: FieldGuideTokens.Work.failed,
            .stalled: FieldGuideTokens.Work.stalledMark, .queued: FieldGuideTokens.Work.queued,
        ]
        let hairline = FieldGuideTokens.hairline
        return Canvas { context, size in
            let gap: CGFloat = 2
            switch track {
            case .indeterminate:
                var x: CGFloat = 0
                while x < size.width {
                    context.fill(
                        Path(roundedRect: CGRect(x: x, y: 0, width: 4, height: size.height), cornerRadius: 1),
                        with: .color(colors[.active]!))
                    x += 8
                }
            case .segments(let units):
                guard !units.isEmpty else { return }
                let width = max(1, (size.width - gap * CGFloat(units.count - 1)) / CGFloat(units.count))
                for (index, unit) in units.enumerated() {
                    let rect = CGRect(
                        x: CGFloat(index) * (width + gap), y: 0, width: width, height: size.height)
                    let path = Path(roundedRect: rect, cornerRadius: 1.5)
                    if unit.state == .queued {
                        context.stroke(path.strokedPath(.init(lineWidth: 1)), with: .color(colors[.queued]!))
                    } else {
                        context.fill(path, with: .color(colors[unit.state]!))
                    }
                }
            case .bar(let runs):
                context.fill(
                    Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 1.5),
                    with: .color(hairline))
                var x: CGFloat = 0
                for run in runs where run.state != .queued {
                    let width = max(0, size.width * run.fraction - gap)
                    context.fill(
                        Path(CGRect(x: x, y: 0, width: width, height: size.height)),
                        with: .color(colors[run.state]!))
                    x += width + gap
                }
            }
        }
    }
}

#Preview("Progress meters") {
    VStack(alignment: .leading, spacing: 16) {
        ProgressMeter(
            value: .init(done: 5, failed: 1, active: 2, total: 12, unit: "orders"), note: "1 failed",
            variant: .row)
        ProgressMeter(value: .init(done: 140, failed: 6, active: 20, queued: 34, total: 200, unit: "photos"))
        ProgressMeter(value: .init(done: 37, total: nil, unit: "emails"), variant: .row)
        ProgressMeter(value: .init(done: 3, total: 8, unit: "steps"), paused: true)
    }
    .padding()
}
