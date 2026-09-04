import PencilKit
import UIKit

final class PencilCanvasView: PKCanvasView, UIPencilInteractionDelegate {
    var onPencilDoubleTap: (() -> Void)?
    var passthroughRects: [CGRect] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        installPencilInteraction()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        installPencilInteraction()
    }

    /// Leaves configured web controls reachable without guessing whether a touch is Pencil or palm input.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !passthroughRects.contains(where: { $0.contains(point) }) else { return nil }
        return super.hitTest(point, with: event)
    }

    /// Maps the Apple Pencil double-tap gesture to the model's tool toggle.
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        onPencilDoubleTap?()
    }

    private func installPencilInteraction() {
        let pencilInteraction = UIPencilInteraction()
        pencilInteraction.delegate = self
        addInteraction(pencilInteraction)
    }
}
