import PencilKit
import UIKit
import WebKit

/// Hosts Dim0's web app while PencilKit remains the local source of truth for handwriting.
@MainActor
final class NativePencilWebContainer: UIView, PKCanvasViewDelegate {
    let webView: PencilAwareWebView

    private let pencilCanvas = PencilCanvasView()
    private let documentStore: NativePencilDocumentStore
    private let sessionId: String
    private var overlayFrame = CGRect.zero
    private var contextId = ""
    private var storedColor = "#1F1F24"
    private var strokeColors: [String: String] = [:]
    private var isErasing = false
    private var currentCamera = NativePencilCamera(x: 0, y: 0, zoom: 1)
    private var pendingCamera: NativePencilCamera?
    private var pendingSave: Task<Void, Never>?
    private var loadGeneration = 0
    private var requestedEnabled = false
    private var isPageAvailable = false
    private var isLoadingDocument = false
    private var isUsingTool = false
    private var isProgrammaticChange = false

    var onPencilDoubleTap: (() -> Void)?

    init(
        webView: PencilAwareWebView,
        documentStore: NativePencilDocumentStore = NativePencilDocumentStore()
    ) {
        self.webView = webView
        self.documentStore = documentStore
        self.sessionId = Self.persistentSessionId()
        super.init(frame: .zero)
        configureViews()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(persistForBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        webView.frame = bounds
        pencilCanvas.frame = overlayFrame.intersection(bounds)
    }

    /// Updates the native tool and viewport without exporting anything on the writing path.
    func configurePencil(
        enabled: Bool,
        frame: CGRect,
        color: UIColor,
        contextId: String,
        storedColor: String,
        width: CGFloat,
        erasing: Bool,
        camera: NativePencilCamera
    ) {
        overlayFrame = frame
        requestedEnabled = enabled
        isPageAvailable = true
        self.storedColor = storedColor
        isErasing = erasing
        if erasing {
            pencilCanvas.tool = PKEraserTool(.vector)
        } else {
            pencilCanvas.tool = PKInkingTool(.pen, color: color, width: width)
        }

        if self.contextId != contextId {
            switchContext(to: contextId, camera: camera)
        } else if camera != currentCamera {
            if isUsingTool {
                pendingCamera = camera
            } else {
                applyCamera(camera)
            }
        }

        updatePencilAvailability()
        setNeedsLayout()
    }

    func disablePencil() {
        requestedEnabled = false
        isPageAvailable = false
        updatePencilAvailability()
    }

    /// Converts the complete drawing only after the explicit Sync button is pressed.
    func syncNow() {
        guard !contextId.isEmpty else { return }
        let strokes = pencilCanvas.drawing.strokes.compactMap { pencilStroke in
            PencilStrokeExporter.exportStroke(pencilStroke, origin: .zero).map { stroke in
                NativeInkStroke(
                    id: stroke.id,
                    tool: stroke.tool,
                    color: strokeColors[stroke.id] ?? stroke.color,
                    width: stroke.width,
                    opacity: stroke.opacity,
                    points: stroke.points
                )
            }
        }
        let snapshot = NativePencilInkSnapshot(
            sessionId: sessionId,
            contextId: contextId,
            camera: currentCamera,
            strokes: strokes
        )
        guard let data = try? JSONEncoder().encode(snapshot),
              let json = String(data: data, encoding: .utf8) else {
            return
        }

        let script = """
        (() => {
          const detail = \(json);
          detail.handled = false;
          window.dispatchEvent(new CustomEvent('dim0:native-pencil-snapshot', { detail }));
          return detail.handled === true;
        })();
        """
        webView.evaluateJavaScript(script)
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        isUsingTool = true
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        isUsingTool = false
        if !isErasing, let stroke = canvasView.drawing.strokes.last {
            strokeColors[PencilStrokeExporter.stableId(for: stroke)] = storedColor
        }
        if let camera = pendingCamera {
            pendingCamera = nil
            applyCamera(camera)
        }
        scheduleSave()
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !isProgrammaticChange else { return }
        scheduleSave()
    }

    private func configureViews() {
        addSubview(webView)
        pencilCanvas.delegate = self
        pencilCanvas.backgroundColor = .clear
        pencilCanvas.isOpaque = false
        pencilCanvas.drawingPolicy = .pencilOnly
        pencilCanvas.isScrollEnabled = false
        pencilCanvas.bounces = false
        pencilCanvas.alwaysBounceHorizontal = false
        pencilCanvas.alwaysBounceVertical = false
        pencilCanvas.isHidden = true
        pencilCanvas.isUserInteractionEnabled = false
        pencilCanvas.onPencilDoubleTap = { [weak self] in
            self?.onPencilDoubleTap?()
        }
        addSubview(pencilCanvas)
    }

    private func switchContext(to newContextId: String, camera: NativePencilCamera) {
        persistCurrentDocument()
        pendingSave?.cancel()
        loadGeneration += 1
        let generation = loadGeneration
        contextId = newContextId
        currentCamera = camera
        isLoadingDocument = true
        isProgrammaticChange = true
        pencilCanvas.drawing = PKDrawing()
        isProgrammaticChange = false
        strokeColors = [:]
        updatePencilAvailability()

        Task { [weak self, documentStore] in
            let document = try? await documentStore.load(contextId: newContextId)
            guard let self, self.loadGeneration == generation, self.contextId == newContextId else { return }
            var drawing = document.flatMap { try? PKDrawing(data: $0.drawing) } ?? PKDrawing()
            if let savedCamera = document?.camera {
                drawing = drawing.transformed(using: Self.cameraTransform(from: savedCamera, to: self.currentCamera))
            }
            self.isProgrammaticChange = true
            self.pencilCanvas.drawing = drawing
            self.isProgrammaticChange = false
            self.strokeColors = document?.strokeColors ?? [:]
            self.isLoadingDocument = false
            self.updatePencilAvailability()
        }
    }

    private func applyCamera(_ camera: NativePencilCamera) {
        let transform = Self.cameraTransform(from: currentCamera, to: camera)
        isProgrammaticChange = true
        pencilCanvas.drawing = pencilCanvas.drawing.transformed(using: transform)
        isProgrammaticChange = false
        currentCamera = camera
        scheduleSave()
    }

    private static func cameraTransform(
        from oldCamera: NativePencilCamera,
        to newCamera: NativePencilCamera
    ) -> CGAffineTransform {
        let scale = newCamera.zoom / oldCamera.zoom
        return CGAffineTransform(
            a: scale,
            b: 0,
            c: 0,
            d: scale,
            tx: (oldCamera.x - newCamera.x) * newCamera.zoom,
            ty: (oldCamera.y - newCamera.y) * newCamera.zoom
        )
    }

    private func updatePencilAvailability() {
        let visible = isPageAvailable && !isLoadingDocument && !overlayFrame.isEmpty
        pencilCanvas.isHidden = !visible
        pencilCanvas.isUserInteractionEnabled = visible && requestedEnabled
    }

    private func scheduleSave() {
        guard !contextId.isEmpty else { return }
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(550))
            guard !Task.isCancelled else { return }
            self?.persistCurrentDocument()
        }
    }

    private func persistCurrentDocument() {
        guard !contextId.isEmpty, !isLoadingDocument else { return }
        let savedContextId = contextId
        let document = NativePencilDocument(
            drawing: pencilCanvas.drawing.dataRepresentation(),
            camera: currentCamera,
            strokeColors: strokeColors
        )
        Task { [documentStore] in
            try? await documentStore.save(document, contextId: savedContextId)
        }
    }

    @objc private func persistForBackground() {
        pendingSave?.cancel()
        persistCurrentDocument()
    }

    private static func persistentSessionId() -> String {
        let key = "dim0.native-sync.session-id"
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: key)
        return created
    }
}

extension UIColor {
    convenience init?(dim0Hex value: String) {
        let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard hex.count == 6, let rgb = UInt64(hex, radix: 16) else { return nil }
        self.init(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }
}
