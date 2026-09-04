import OSLog
import PencilKit
import UIKit
import WebKit

/// Hosts Dim0's web app while PencilKit journals ink until the web store durably accepts it.
@MainActor
final class NativePencilWebContainer: UIView, PKCanvasViewDelegate {
    private struct InFlightPublish {
        let messageId: String
        let contextId: String
        let generation: Int
        let strokeIds: Set<String>
        let manual: Bool
    }

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.dim0.canvas",
        category: "NativePencil"
    )
    private static let maximumStrokesPerMessage = 128
    private static let maximumPointsPerMessage = 50_000

    let webView: PencilAwareWebView

    private let pencilCanvas = PencilCanvasView()
    private let documentStore: NativePencilDocumentStore
    private let sessionId: String
    private var overlayFrame = CGRect.zero
    private var contextId = ""
    private var storedColor = "#1F1F24"
    private var strokeColors: [String: String] = [:]
    private var worldDrawing = PKDrawing()
    private var inFlightPublish: InFlightPublish?
    private var publishTimeout: Task<Void, Never>?
    private var manualPublishQueued = false
    private var manualSyncTotal = 0
    private var requiresLegacyManualSync = false
    private var acknowledgedWhileUsingTool: Set<String> = []
    private var isErasing = false
    private var currentCamera = NativePencilCamera(x: 0, y: 0, zoom: 1)
    private var pendingCamera: NativePencilCamera?
    private var pendingContext: (id: String, camera: NativePencilCamera)?
    private var pendingSave: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?
    private var saveRevision: UInt64 = 0
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    private var loadGeneration = 0
    private var requestedEnabled = false
    private var isPageAvailable = false
    private var isLoadingDocument = false
    private var isUsingTool = false
    private var isProgrammaticChange = false
    private var hasUncapturedChanges = false

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
        requestedEnabled = enabled && !erasing
        isPageAvailable = true
        self.storedColor = storedColor
        isErasing = erasing
        if erasing {
            pencilCanvas.tool = PKEraserTool(.vector)
        } else {
            pencilCanvas.tool = PKInkingTool(.pen, color: color, width: width)
        }

        if self.contextId != contextId {
            if isUsingTool {
                pendingContext = (contextId, camera)
            } else {
                switchContext(to: contextId, camera: camera)
            }
        } else {
            pendingContext = nil
            if camera != currentCamera {
                if isUsingTool {
                    pendingCamera = camera
                } else {
                    applyCamera(camera)
                }
            } else if isUsingTool {
                pendingCamera = nil
            }
        }

        updatePencilAvailability()
        publishPendingChanges()
        setNeedsLayout()
    }

    func disablePencil() {
        requestedEnabled = false
        isPageAvailable = false
        updatePencilAvailability()
    }

    /// Flushes every locally pending stroke when the user explicitly requests a sync.
    func syncNow() {
        guard !contextId.isEmpty, !isLoadingDocument else { return }
        captureWorldDrawing()
        manualPublishQueued = true
        manualSyncTotal = worldDrawing.strokes.count
        publishPendingChanges()
    }

    /// Commits one in-flight batch only after the trusted page confirms durable handling.
    func acknowledge(messageId: String, handled: Bool) {
        guard let publish = inFlightPublish,
              publish.messageId == messageId,
              publish.contextId == contextId,
              publish.generation == loadGeneration else {
            return
        }

        publishTimeout?.cancel()
        publishTimeout = nil
        inFlightPublish = nil

        guard handled else {
            if publish.manual { manualPublishQueued = true }
            return
        }

        if publish.manual {
            manualSyncTotal = 0
            requiresLegacyManualSync = false
        }
        if !publish.strokeIds.isEmpty {
            worldDrawing = PKDrawing(strokes: worldDrawing.strokes.filter {
                !publish.strokeIds.contains(PencilStrokeExporter.stableId(for: $0))
            })
            for strokeId in publish.strokeIds {
                strokeColors.removeValue(forKey: strokeId)
            }
            if isUsingTool {
                acknowledgedWhileUsingTool.formUnion(publish.strokeIds)
            } else {
                renderWorldDrawing(for: currentCamera)
            }
            scheduleSave()
        }
        publishPendingChanges()
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        isUsingTool = true
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        isUsingTool = false
        captureWorldDrawing()
        if !isErasing, let stroke = worldDrawing.strokes.last {
            strokeColors[PencilStrokeExporter.stableId(for: stroke)] = storedColor
        }
        if !acknowledgedWhileUsingTool.isEmpty {
            acknowledgedWhileUsingTool.removeAll()
            renderWorldDrawing(for: currentCamera)
        }
        if let pendingContext {
            self.pendingContext = nil
            pendingCamera = nil
            switchContext(to: pendingContext.id, camera: pendingContext.camera)
            return
        }
        publishPendingChanges()
        if let camera = pendingCamera {
            pendingCamera = nil
            applyCamera(camera)
        }
        scheduleSave()
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !isProgrammaticChange else { return }
        hasUncapturedChanges = true
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
        publishTimeout?.cancel()
        inFlightPublish = nil
        manualPublishQueued = false
        manualSyncTotal = 0
        requiresLegacyManualSync = false
        acknowledgedWhileUsingTool.removeAll()
        pendingCamera = nil
        pendingContext = nil
        loadGeneration += 1
        let generation = loadGeneration
        contextId = newContextId
        currentCamera = camera
        isLoadingDocument = true
        isProgrammaticChange = true
        pencilCanvas.drawing = PKDrawing()
        isProgrammaticChange = false
        worldDrawing = PKDrawing()
        hasUncapturedChanges = false
        strokeColors = [:]
        updatePencilAvailability()

        let priorSave = saveTask
        Task { [weak self, documentStore] in
            await priorSave?.value
            let document: NativePencilDocument?
            do {
                document = try await documentStore.load(contextId: newContextId)
            } catch {
                Self.logger.error("Unable to load Pencil journal: \(error.localizedDescription, privacy: .public)")
                document = nil
            }
            guard let self, self.loadGeneration == generation, self.contextId == newContextId else { return }
            let storedDrawing = document.flatMap { try? PKDrawing(data: $0.drawing) } ?? PKDrawing()
            if document?.coordinateSpace == "pending-world-v1" {
                self.worldDrawing = storedDrawing
                self.requiresLegacyManualSync = false
            } else if document?.coordinateSpace == "world-v1" {
                self.worldDrawing = storedDrawing
                self.requiresLegacyManualSync = !storedDrawing.strokes.isEmpty
            } else if let savedCamera = document?.camera {
                self.worldDrawing = storedDrawing.transformed(using: Self.screenToWorldTransform(savedCamera))
                self.requiresLegacyManualSync = !storedDrawing.strokes.isEmpty
            } else {
                self.worldDrawing = storedDrawing
                self.requiresLegacyManualSync = !storedDrawing.strokes.isEmpty
            }
            self.strokeColors = document?.strokeColors ?? [:]
            self.renderWorldDrawing(for: self.currentCamera)
            self.isLoadingDocument = false
            self.updatePencilAvailability()
            self.publishPendingChanges()
        }
    }

    private func applyCamera(_ camera: NativePencilCamera) {
        currentCamera = camera
        renderWorldDrawing(for: camera)
    }

    /// Projects stable board-world coordinates into the current PencilKit overlay.
    static func worldToScreenTransform(_ camera: NativePencilCamera) -> CGAffineTransform {
        return CGAffineTransform(
            a: camera.zoom,
            b: 0,
            c: 0,
            d: camera.zoom,
            tx: -camera.x * camera.zoom,
            ty: -camera.y * camera.zoom
        )
    }

    /// Converts overlay coordinates back to stable board-world coordinates.
    static func screenToWorldTransform(_ camera: NativePencilCamera) -> CGAffineTransform {
        worldToScreenTransform(camera).inverted()
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
        captureWorldDrawing()
        let savedContextId = contextId
        let document = NativePencilDocument(
            drawing: worldDrawing.dataRepresentation(),
            camera: currentCamera,
            coordinateSpace: requiresLegacyManualSync ? "world-v1" : "pending-world-v1",
            strokeColors: strokeColors
        )
        saveRevision &+= 1
        let revision = saveRevision
        let priorSave = saveTask
        saveTask = Task { [documentStore] in
            await priorSave?.value
            do {
                try await documentStore.save(document, contextId: savedContextId, revision: revision)
            } catch {
                Self.logger.error("Unable to save Pencil journal: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    @objc private func persistForBackground() {
        pendingSave?.cancel()
        let application = UIApplication.shared
        if backgroundTask != .invalid {
            application.endBackgroundTask(backgroundTask)
        }
        backgroundTask = application.beginBackgroundTask { [weak self] in
            Task { @MainActor in self?.finishBackgroundTask() }
        }
        persistCurrentDocument()
        let currentSave = saveTask
        Task { [weak self] in
            await currentSave?.value
            self?.finishBackgroundTask()
        }
    }

    private func finishBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Captures user edits once in world space instead of repeatedly transforming prior output.
    private func captureWorldDrawing() {
        guard !isProgrammaticChange,
              !isLoadingDocument,
              !isUsingTool,
              hasUncapturedChanges else {
            return
        }

        let screenStrokes = pencilCanvas.drawing.strokes.filter {
            !acknowledgedWhileUsingTool.contains(PencilStrokeExporter.stableId(for: $0))
        }
        let screenIds = Set(screenStrokes.map { PencilStrokeExporter.stableId(for: $0) })
        let worldIds = Set(worldDrawing.strokes.map { PencilStrokeExporter.stableId(for: $0) })
        let retainedWorldStrokes = worldDrawing.strokes.filter {
            screenIds.contains(PencilStrokeExporter.stableId(for: $0))
        }
        let newScreenStrokes = screenStrokes.filter {
            !worldIds.contains(PencilStrokeExporter.stableId(for: $0))
        }
        let newWorldStrokes = PKDrawing(strokes: newScreenStrokes)
            .transformed(using: Self.screenToWorldTransform(currentCamera))
            .strokes
        worldDrawing = PKDrawing(strokes: retainedWorldStrokes + newWorldStrokes)
        let currentIds = Set(worldDrawing.strokes.map { PencilStrokeExporter.stableId(for: $0) })
        strokeColors = strokeColors.filter { currentIds.contains($0.key) }
        hasUncapturedChanges = false
    }

    private func renderWorldDrawing(for camera: NativePencilCamera) {
        isProgrammaticChange = true
        pencilCanvas.drawing = worldDrawing.transformed(using: Self.worldToScreenTransform(camera))
        isProgrammaticChange = false
    }

    /// Sends pending ink in bounded, ordered batches; ACK removes it from the native journal.
    private func publishPendingChanges() {
        guard isPageAvailable,
              !contextId.isEmpty,
              !isLoadingDocument,
              inFlightPublish == nil else {
            return
        }

        let pendingCount = worldDrawing.strokes.count
        guard pendingCount > 0 || manualPublishQueued else { return }
        guard !requiresLegacyManualSync || manualPublishQueued else { return }
        let batch = nextPendingBatch()
        let hasMore = pendingCount > batch.count
        let manual = manualPublishQueued && !hasMore
        if manual { manualPublishQueued = false }

        let screenDrawing = PKDrawing(strokes: batch)
            .transformed(using: Self.worldToScreenTransform(currentCamera))
        let messageId = UUID().uuidString.lowercased()
        let sentIds = Set(batch.map { PencilStrokeExporter.stableId(for: $0) })
        let delta = NativePencilInkDelta(
            messageId: messageId,
            manual: manual,
            sessionId: sessionId,
            contextId: contextId,
            camera: currentCamera,
            strokes: exportStrokes(screenDrawing.strokes),
            removedStrokeIds: [],
            total: min(1_000_000, manual ? manualSyncTotal : pendingCount)
        )

        inFlightPublish = InFlightPublish(
            messageId: messageId,
            contextId: contextId,
            generation: loadGeneration,
            strokeIds: sentIds,
            manual: manual
        )
        guard dispatch(delta, messageId: messageId) else {
            inFlightPublish = nil
            if manual { manualPublishQueued = true }
            return
        }
        schedulePublishTimeout(messageId: messageId)
    }

    private func schedulePublishTimeout(messageId: String) {
        publishTimeout?.cancel()
        publishTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.acknowledge(messageId: messageId, handled: false)
        }
    }

    private func nextPendingBatch() -> [PKStroke] {
        var batch: [PKStroke] = []
        var estimatedPointCount = 0
        for stroke in worldDrawing.strokes.prefix(Self.maximumStrokesPerMessage) {
            let pathCount = stroke.path.count
            let estimatedPoints = pathCount >= Self.maximumPointsPerMessage / 4
                ? Self.maximumPointsPerMessage
                : max(1, pathCount * 4 + 1)
            if !batch.isEmpty && estimatedPointCount + estimatedPoints > Self.maximumPointsPerMessage {
                break
            }
            batch.append(stroke)
            estimatedPointCount += estimatedPoints
        }
        return batch
    }

    private func exportStrokes(_ strokes: [PKStroke]) -> [NativeInkStroke] {
        strokes.compactMap { pencilStroke in
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
    }

    private func dispatch<Message: Encodable>(_ message: Message, messageId: String) -> Bool {
        guard let data = try? JSONEncoder().encode(message),
              let json = String(data: data, encoding: .utf8) else {
            return false
        }
        let script = """
        (() => {
          const detail = \(json);
          window.dispatchEvent(new CustomEvent('dim0:native-pencil-snapshot', { detail }));
          return true;
        })();
        """
        webView.evaluateJavaScript(script) { [weak self] _, error in
            guard error != nil else { return }
            Task { @MainActor in
                self?.acknowledge(messageId: messageId, handled: false)
            }
        }
        return true
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
