import { create } from "zustand"
import { zhCN } from "./translations/zh-CN"


export type Locale = "en" | "zh-CN"
export type LanguagePreference = Locale | "system"
const STORAGE_KEY = "dim0-language"


/** Resolve a saved preference, falling back to the device language. */
export function resolveLocale(preference: LanguagePreference, deviceLanguage = typeof navigator === "undefined" ? "en" : navigator.language): Locale {
  return preference === "system" ? (deviceLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en") : preference
}


/** Ignore invalid or inaccessible storage without blocking the app. */
function readPreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === "en" || value === "zh-CN") return value
  } catch { /* Private browsing may deny storage. */ }
  return "system"
}


export const useLocaleStore = create<{
  preference: LanguagePreference
  locale: Locale
  setLanguage: (preference: LanguagePreference) => void
}>(() => ({
  preference: readPreference(),
  locale: resolveLocale(readPreference()),
  setLanguage: (preference) => {
    try { localStorage.setItem(STORAGE_KEY, preference) } catch { /* Keep the in-memory choice. */ }
    useLocaleStore.setState({ preference, locale: resolveLocale(preference) })
  },
}))


/** Update accessibility language and synchronize other tabs/device changes. */
export function initLanguage(): void {
  const updateDocument = (): void => { document.documentElement.lang = useLocaleStore.getState().locale }
  updateDocument()
  useLocaleStore.subscribe(updateDocument)
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    const preference = readPreference()
    useLocaleStore.setState({ preference, locale: resolveLocale(preference) })
  })
  window.addEventListener("languagechange", () => {
    const { preference } = useLocaleStore.getState()
    useLocaleStore.setState({ locale: resolveLocale(preference) })
  })
}


/** Translate UI copy only; unknown copy falls back to English. */
export function t(message: string, values?: Record<string, string | number>): string {
  const translated = useLocaleStore.getState().locale === "zh-CN" ? (zhCN[message] ?? message) : message
  return translated.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match))
}


/** Subscribe a component to language changes without remounting its state. */
export function useT(): typeof t {
  useLocaleStore((state) => state.locale)
  return t
}
