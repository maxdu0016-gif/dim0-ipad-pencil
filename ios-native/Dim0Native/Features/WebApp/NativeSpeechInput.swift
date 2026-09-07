import AVFoundation
import Speech
import UIKit
import WebKit

/// One user-started dictation session; transcripts are drafts, never AI submissions.
@MainActor
final class NativeSpeechInput: NSObject {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var requestID: String?
    private var text = ""
    private var hasTap = false
    private var sessionActive = false
    private var deadline: Task<Void, Never>?
    private weak var webView: WKWebView?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
    }

    /// Begin only after both system permissions are granted and the request is still current.
    func start(id: String, locale: String, webView: WKWebView?) {
        cancel()
        requestID = id
        self.webView = webView
        text = ""
        Task { [weak self] in
            let speech = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
            guard let self, self.requestID == id else { return }
            guard speech else { self.finish(error: "请在 iPad 设置中允许 Dim0 使用语音识别。"); return }
            let microphone = await AVAudioApplication.requestRecordPermission()
            guard self.requestID == id else { return }
            guard microphone else { self.finish(error: "请在 iPad 设置中允许 Dim0 使用麦克风。"); return }
            self.record(id: id, locale: locale)
        }
    }

    /// Feed microphone buffers to Apple's recognizer and return partial transcripts to this page.
    private func record(id: String, locale: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            finish(error: "当前语言的语音识别暂不可用，请检查网络或使用键盘听写。")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true)
            sessionActive = true
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                finish(error: "麦克风暂不可用。")
                return
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            hasTap = true
            recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self, self.requestID == id else { return }
                    if let result { self.text = result.bestTranscription.formattedString }
                    if result?.isFinal == true { self.finish() }
                    else if error != nil { self.finish(error: "听写已结束；请检查已识别文字，必要时重试。") }
                    else { self.emit(done: false) }
                }
            }
            engine.prepare()
            try engine.start()
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled, self?.requestID == id else { return }
                self?.stop(id: id)
            }
        } catch {
            finish(error: "无法启动麦克风，请检查权限后重试。")
        }
    }

    /// Stop the microphone immediately, allowing a bounded wait for the final transcript.
    func stop(id: String) {
        guard requestID == id else { return }
        guard request != nil else { finish(); return }
        stopAudio()
        request?.endAudio()
        deadline?.cancel()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, self?.requestID == id else { return }
            self?.finish()
        }
    }

    /// Cancel on dialog dismissal, navigation, or teardown; stale callbacks cannot update a new draft.
    func cancel(id: String? = nil) {
        guard id == nil || id == requestID else { return }
        requestID = nil
        deadline?.cancel()
        deadline = nil
        stopAudio()
        recognition?.cancel()
        recognition = nil
        request = nil
        webView = nil
    }

    private func stopAudio() {
        engine.stop()
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        if sessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            sessionActive = false
        }
    }

    private func finish(error: String? = nil) {
        emit(done: true, error: error)
        cancel()
    }

    /// Pass structured arguments instead of interpolating recognized speech into executable JavaScript.
    private func emit(done: Bool, error: String? = nil) {
        guard let requestID else { return }
        var detail: [String: Any] = ["requestId": requestID, "text": text, "done": done]
        if let error { detail["error"] = error }
        webView?.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('dim0:speech', { detail }))", arguments: ["detail": detail], in: nil, contentWorld: .page)
    }

    @objc private func interrupted() {
        guard requestID != nil else { return }
        finish(error: "录音已中断；请检查已识别的文字。")
    }
}
