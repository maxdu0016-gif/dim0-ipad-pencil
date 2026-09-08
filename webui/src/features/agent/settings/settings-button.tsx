import { ToolsMenuIcon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { SettingsDialog } from "./settings-dialog"
import { useT } from "@/lib/i18n"


/**
 * Opens the unified agent settings dialog. `emphasize` lifts the icon to
 * secondary-foreground with a soft ring — used when no model key is set and the
 * rest of the island is dimmed, to point the user at settings.
 */
export const SettingsButton = ({ emphasize = false }: { emphasize?: boolean }) => {
  const t = useT()
  return (
  <SettingsDialog
    trigger={
      <button
        type="button"
        title={t(emphasize ? "Set a model to start" : "Settings")}
        aria-label={t("Agent settings")}
        className={cn(
          "shrink-0 rounded-lg p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-foreground/30",
          emphasize
            ? "text-secondary-foreground ring-2 ring-secondary-foreground/30 hover:bg-accent"
            : "text-muted-foreground border border-transparent hover:border-border hover:bg-accent",
        )}
      >
        <ToolsMenuIcon className="size-4 shrink-0" />
      </button>
    }
  />
)
}
