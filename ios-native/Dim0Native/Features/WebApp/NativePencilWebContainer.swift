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

    private struct ToolConfiguration {
        let color: UIColor
        let storedColor: String
        let width: CGFloat
        let erasing: Bool
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
    private var passthroughRects = [CGRect]()
    private var contextId = ""
    private var storedColor = "#1F1F24"
    private var strokeColors: [String: String] = [:]
    private var worldDrawing = PKDrawing()
    private var inFlightPublish: InFlightPublish?
    private var publishTimeout: Task<Void, Never>?
    private var manualPublishQueued = false
    private var manualSyncTotal = 0
    private var requiresLegacyManualSync = false
    private var deferredAcknowledgedStrokeIds: Set<String> = []
    private var isErasing = false
    private var currentCamera = NativePencilCamera(x: 0, y: 0, zoom: 1)
    private var pendingCamera: NativePencilCamera?
    private var pendingContext: (id: String, camera: NativePencilCamera)?
    private var finalDrawingFallback: Task<Void, Never>?
    private var automaticPublish: Task<Void, Never>?
    private var canvasReconciliation: Task<Void, Never>?
    private var pendingSave: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?
    private var saveRevision: UInt64 = 0
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    private var loadGeneration = 0
    private var requestedEnabled = false
    private var isPageAvailable = false
    private var isLoadingDocument = false
    private var isUsingTool = false
    private var isAwaitingFinalDrawingChange = false
    private var isProgrammaticChange = false
    private var hasUncapturedChanges = false
    private var configuredEraser: Bool?
    private var configuredInkColor: UIColor?
    private var configuredInkWidth: CGFloat?
    private var pendingToolConfiguration: ToolConfiguration?

    private var canCaptureCanvasDrawing: Bool {
        Self.canCaptureCanvasDrawing(
            isUsingTool: isUsingTool,
            isAwaitingFinalDrawingChange: isAwaitingFinalDrawingChange
        )
    }

    private var canReplaceCanvasDrawing: Bool {
        Self.canReplaceCanvasDrawing(
            isUsingTool: isUsingTool,
            isAwaitingFinalDrawingChange: isAwaitingFinalDrawingChange,
            isDrawingGestureActive: Self.isActiveDrawingGesture(pencilCanvas.drawingGestureRecognizer.state)
        )
    }

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

    /// Aligns the web app, native ink overlay, and web-control passthrough regions.
    override func layoutSubviews() {
        super.layoutSubviews()
        webView.frame = bounds
        let clippedFrame = overlayFrame.intersection(bounds)
        pencilCanvas.frame = clippedFrame.isNull ? .zero : clippedFrame
        pencilCanvas.passthroughRects = passthroughRects.compactMap { rect in
            let localRect = pencilCanvas.convert(rect, from: self).intersection(pencilCanvas.bounds)
            return localRect.isNull || localRect.isEmpty ? nil : localRect
        }
    }

    /// Updates the native tool, viewport, and web-control holes without exporting on the writing path.
    func configurePencil(
        enabled: Bool,
        frame: CGRect,
        passthroughRects: [CGRect],
        color: UIColor,
        contextId: String,
        storedColor: String,
        width: CGFloat,
        erasing: Bool,
        camera: NativePencilCamera
    ) {
        overlayFrame = frame
        self.passthroughRects = passthroughRects
        requestedEnabled = enabled && !erasing
        isPageAvailable = true
        configureToolIfNeeded(
            color: color,
            storedColor: storedColor,
            width: width,
            erasing: erasing
        )

        if self.contextId != contextId {
            if !canReplaceCanvasDrawing {
                pendingContext = (contextId, camera)
            } else {
                switchContext(to: contextId, camera: camera)
            }
        } else {
            pendingContext = nil
            if camera != currentCamera {
                if !canReplaceCanvasDrawing {
                    pendingCamera = camera
                } else {
                    applyCamera(camera)
                }
            } else {
                pendingCamera = nil
            }
        }

        updatePencilAvailability()
        scheduleAutomaticPublish()
        scheduleCanvasReconciliation()
        setNeedsLayout()
    }

    /// Stops input and pending idle work while WebKit replaces the active page.
    func disablePencil() {
        automaticPublish?.cancel()
        automaticPublish = nil
        canvasReconciliation?.cancel()
        canvasReconciliation = nil
        requestedEnabled = false
        isPageAvailable = false
        updatePencilAvailability()
    }

    /// Flushes every locally pending stroke when the user explicitly requests a sync.
    func syncNow() {
        guard !contextId.isEmpty, !isLoadingDocument else { return }
        automaticPublish?.cancel()
        automaticPublish = nil
        manualPublishQueued = true
        guard canReplaceCanvasDrawing else { return }
        captureWorldDrawing()
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
            scheduleAutomaticPublish()
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
            deferredAcknowledgedStrokeIds.formUnion(publish.strokeIds)
            scheduleCanvasReconciliation()
            scheduleSave()
        }
        if manualPublishQueued {
            publishPendingChanges()
        } else {
            scheduleAutomaticPublish()
        }
    }

    /// Keeps serialization, bridge delivery, and canvas replacement out of an active Pencil sequence.
    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        automaticPublish?.cancel()
        automaticPublish = nil
        canvasReconciliation?.cancel()
        canvasReconciliation = nil
        pendingSave?.cancel()
        pendingSave = nil
        finalDrawingFallback?.cancel()
        finalDrawingFallback = nil
        isUsingTool = true
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        isUsingTool = false
        isAwaitingFinalDrawingChange = true
        scheduleFinalDrawingFallback()
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        guard !isProgrammaticChange else { return }
        hasUncapturedChanges = true
        guard Self.shouldFinishDrawingChange(
            isUsingTool: isUsingTool,
            isDrawingGestureActive: Self.isActiveDrawingGesture(canvasView.drawingGestureRecognizer.state)
        ) else { return }
        finalDrawingFallback?.cancel()
        finalDrawingFallback = nil
        isAwaitingFinalDrawingChange = false
        finishDrawingChange()
    }

    /// Releases a tool sequence that ended without a final content-change callback.
    private func scheduleFinalDrawingFallback() {
        finalDrawingFallback?.cancel()
        finalDrawingFallback = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            // Drawing-change callbacks commonly precede tool-up, so pending changes must not block this fallback.
            guard !Task.isCancelled,
                  let self,
                  Self.shouldFinishDrawingFallback(
                      isUsingTool: self.isUsingTool,
                      isAwaitingFinalDrawingChange: self.isAwaitingFinalDrawingChange
                  ) else {
                return
            }
            self.isAwaitingFinalDrawingChange = false
            self.finalDrawingFallback = nil
            self.finishDrawingChange()
        }
    }

    /// Captures and publishes only after PencilKit reports its final post-touch drawing update.
    private func finishDrawingChange() {
        let hadUncapturedChanges = hasUncapturedChanges
        captureWorldDrawing()
        if hadUncapturedChanges, !isErasing, let stroke = worldDrawing.strokes.last {
            strokeColors[PencilStrokeExporter.stableId(for: stroke)] = storedColor
        }
        applyPendingToolConfiguration()
        if !deferredAcknowledgedStrokeIds.isEmpty
                || pendingCamera != nil
                || pendingToolConfiguration != nil {
            scheduleCanvasReconciliation()
        }
        if let pendingContext {
            self.pendingContext = nil
            pendingCamera = nil
            switchContext(to: pendingContext.id, camera: pendingContext.camera)
            return
        }
        if manualPublishQueued {
            manualSyncTotal = worldDrawing.strokes.count
            publishPendingChanges()
            scheduleAutomaticPublish()
        } else {
            scheduleAutomaticPublish()
        }
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
        guard canReplaceCanvasDrawing else {
            pendingContext = (newContextId, camera)
            return
        }
        persistCurrentDocument()
        automaticPublish?.cancel()
        automaticPublish = nil
        canvasReconciliation?.cancel()
        canvasReconciliation = nil
        finalDrawingFallback?.cancel()
        finalDrawingFallback = nil
        pendingSave?.cancel()
        publishTimeout?.cancel()
        inFlightPublish = nil
        manualPublishQueued = false
        manualSyncTotal = 0
        requiresLegacyManualSync = false
        deferredAcknowledgedStrokeIds.removeAll()
        pendingCamera = nil
        pendingContext = nil
        loadGeneration += 1
        let generation = loadGeneration
        contextId = newContextId
        currentCamera = camera
        isLoadingDocument = true
        isAwaitingFinalDrawingChange = false
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
        guard canReplaceCanvasDrawing else {
            pendingCamera = camera
            return
        }
        pendingCamera = nil
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

    /// Allows reading a complete drawing after PencilKit has ended its finalization window.
    static func canCaptureCanvasDrawing(
        isUsingTool: Bool,
        isAwaitingFinalDrawingChange: Bool
    ) -> Bool {
        !isUsingTool && !isAwaitingFinalDrawingChange
    }

    /// Prevents model reconciliation from replacing a drawing before PencilKit finalizes it.
    static func canReplaceCanvasDrawing(
        isUsingTool: Bool,
        isAwaitingFinalDrawingChange: Bool,
        isDrawingGestureActive: Bool = false
    ) -> Bool {
        !isUsingTool && !isAwaitingFinalDrawingChange && !isDrawingGestureActive
    }

    /// Releases PencilKit's finalization window even when its last change arrived before tool-up.
    static func shouldFinishDrawingFallback(
        isUsingTool: Bool,
        isAwaitingFinalDrawingChange: Bool
    ) -> Bool {
        !isUsingTool && isAwaitingFinalDrawingChange
    }

    /// Rejects a partial drawing-change callback that beats PencilKit's begin-tool delegate callback.
    static func shouldFinishDrawingChange(
        isUsingTool: Bool,
        isDrawingGestureActive: Bool
    ) -> Bool {
        !isUsingTool && !isDrawingGestureActive
    }

    /// Treats PencilKit's recognizer as active even before its delegate callback reaches the container.
    private static func isActiveDrawingGesture(_ state: UIGestureRecognizer.State) -> Bool {
        state == .began || state == .changed
    }

    /// Avoids resetting PencilKit's active tool for duplicate web configuration messages.
    private func configureToolIfNeeded(
        color: UIColor,
        storedColor: String,
        width: CGFloat,
        erasing: Bool
    ) {
        guard configuredEraser != erasing
                || configuredInkColor?.isEqual(color) != true
                || configuredInkWidth != width
                || self.storedColor != storedColor else {
            pendingToolConfiguration = nil
            return
        }
        let configuration = ToolConfiguration(
            color: color,
            storedColor: storedColor,
            width: width,
            erasing: erasing
        )
        guard canReplaceCanvasDrawing else {
            pendingToolConfiguration = configuration
            return
        }
        applyToolConfiguration(configuration)
    }

    /// Applies the latest tool request after the current Pencil sequence is complete.
    private func applyPendingToolConfiguration() {
        guard canReplaceCanvasDrawing, let configuration = pendingToolConfiguration else { return }
        applyToolConfiguration(configuration)
    }

    /// Commits one deferred or newly changed PencilKit tool configuration.
    private func applyToolConfiguration(_ configuration: ToolConfiguration) {
        pendingToolConfiguration = nil
        let color = configuration.color
        let width = configuration.width
        let erasing = configuration.erasing
        configuredEraser = erasing
        configuredInkColor = color
        configuredInkWidth = width
        storedColor = configuration.storedColor
        isErasing = erasing
        if erasing {
            pencilCanvas.tool = PKEraserTool(.vector)
        } else {
            pencilCanvas.tool = PKInkingTool(.pen, color: color, width: width)
        }
    }

    private func updatePencilAvailability() {
        let visible = isPageAvailable && !isLoadingDocument && !overlayFrame.isEmpty
        pencilCanvas.isHidden = !visible
        pencilCanvas.isUserInteractionEnabled = visible && requestedEnabled
    }

    /// Debounces journal serialization until Pencil input is safely idle.
    private func scheduleSave() {
        guard !contextId.isEmpty else { return }
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(550))
            guard !Task.isCancelled, let self, self.canReplaceCanvasDrawing else { return }
            self.persistCurrentDocument()
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
              canCaptureCanvasDrawing,
              hasUncapturedChanges else {
            return
        }

        let screenStrokes = pencilCanvas.drawing.strokes.filter {
            !deferredAcknowledgedStrokeIds.contains(PencilStrokeExporter.stableId(for: $0))
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

    /// Replaces the overlay only when the projected world drawing actually changed.
    private func renderWorldDrawing(for camera: NativePencilCamera) {
        let renderedDrawing = worldDrawing.transformed(using: Self.worldToScreenTransform(camera))
        guard pencilCanvas.drawing != renderedDrawing else { return }
        isProgrammaticChange = true
        pencilCanvas.drawing = renderedDrawing
        isProgrammaticChange = false
    }

    /// Batches completed strokes until a short Pencil pause keeps bridge ACKs off the writing path.
    private func scheduleAutomaticPublish() {
        guard isPageAvailable,
              !contextId.isEmpty,
              !isLoadingDocument,
              !worldDrawing.strokes.isEmpty,
              automaticPublish == nil else {
            return
        }
        automaticPublish = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }
            self.automaticPublish = nil
            self.publishPendingChanges()
        }
    }

    /// Applies deferred ACK, camera, or tool changes after the next Pencil contact has time to begin.
    private func scheduleCanvasReconciliation() {
        guard !deferredAcknowledgedStrokeIds.isEmpty
                || pendingCamera != nil
                || pendingToolConfiguration != nil else {
            return
        }
        canvasReconciliation?.cancel()
        canvasReconciliation = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self else { return }
            self.canvasReconciliation = nil
            guard self.canReplaceCanvasDrawing else { return }
            self.captureWorldDrawing()
            self.deferredAcknowledgedStrokeIds.removeAll()
            self.applyCamera(self.pendingCamera ?? self.currentCamera)
            self.applyPendingToolConfiguration()
        }
    }

    /// Sends pending ink in bounded, ordered batches; ACK removes it from the native journal.
    private func publishPendingChanges() {
        guard isPageAvailable,
              !contextId.isEmpty,
              !isLoadingDocument,
              inFlightPublish == nil,
              canReplaceCanvasDrawing else {
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
