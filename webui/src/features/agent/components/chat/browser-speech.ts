export type BrowserSpeech = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}


/** Safari and Chromium expose the same recognition API under different names. */
export const browserSpeechConstructor = (): (new () => BrowserSpeech) | undefined => {
  const browser = window as typeof window & {
    SpeechRecognition?: new () => BrowserSpeech
    webkitSpeechRecognition?: new () => BrowserSpeech
  }
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition
}
