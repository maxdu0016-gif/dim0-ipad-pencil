import { useId } from "react"
import { t, useLocaleStore } from "@/lib/i18n"


/** Device-local language preference, available without signing in. */
export function LanguageSetting() {
  const id = useId()
  const { preference, setLanguage } = useLocaleStore()
  return (
    <div className="mb-5 space-y-2 rounded-lg border border-border p-3">
      <label htmlFor={id} className="block text-sm font-medium">语言 / Language</label>
      <select id={id} value={preference} onChange={(event) => {
        const value = event.target.value
        if (value === "system" || value === "en" || value === "zh-CN") setLanguage(value)
      }} className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm">
        <option value="system">{t("Follow device language")}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
      <p className="text-xs text-muted-foreground">{t("Applies immediately on this device. Your notes stay unchanged.")}</p>
    </div>
  )
}
