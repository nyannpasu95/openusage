import { useMemo } from "react";
import { Hourglass, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UpdateStatus } from "@/hooks/use-app-update";
import { useNowTicker } from "@/hooks/use-now-ticker";

interface PanelFooterProps {
  autoUpdateNextAt: number | null;
  updateStatus: UpdateStatus;
  onUpdateInstall: () => void;
  onUpdateCheck: () => void;
  onRefreshAll?: () => void;
  isRefreshing?: boolean;
  refreshCooldownEndsAt?: number | null;
  lastUpdatedAt?: number | null;
}

function formatRelativeTime(diffMs: number): string {
  const seconds = Math.floor(Math.max(0, diffMs) / 1000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function VersionDisplay({
  updateStatus,
  onUpdateInstall,
  onUpdateCheck,
}: {
  updateStatus: UpdateStatus;
  onUpdateInstall: () => void;
  onUpdateCheck: () => void;
}) {
  switch (updateStatus.status) {
    case "downloading":
      return (
        <span className="text-xs text-muted-foreground">
          {updateStatus.progress >= 0
            ? `Downloading update ${updateStatus.progress}%`
            : "Downloading update..."}
        </span>
      );
    case "ready":
      return (
        <Button
          variant="destructive"
          size="xs"
          className="update-border-beam"
          onClick={onUpdateInstall}
        >
          Restart to update
        </Button>
      );
    case "installing":
      return (
        <span className="text-xs text-muted-foreground">Installing...</span>
      );
    case "error":
      if (updateStatus.message === "Update check failed") {
        return (
          <button
            type="button"
            onClick={onUpdateCheck}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            title={updateStatus.message}
          >
            Updates soon
          </button>
        );
      }
      return (
        <span className="text-xs text-destructive" title={updateStatus.message}>
          Update failed
        </span>
      );
    default:
      // Idle: no version display. The About dialog is no longer surfaced here;
      // the version is still visible on installed builds via the app bundle.
      return null;
  }
}

export function PanelFooter({
  autoUpdateNextAt,
  updateStatus,
  onUpdateInstall,
  onUpdateCheck,
  onRefreshAll,
  isRefreshing,
  refreshCooldownEndsAt,
  lastUpdatedAt,
}: PanelFooterProps) {
  const now = useNowTicker({
    enabled:
      Boolean(autoUpdateNextAt) ||
      Boolean(refreshCooldownEndsAt) ||
      Boolean(lastUpdatedAt),
    resetKey: autoUpdateNextAt ?? refreshCooldownEndsAt ?? lastUpdatedAt,
  });

  const countdownLabel = useMemo(() => {
    if (!autoUpdateNextAt) return "Paused";
    const remainingMs = Math.max(0, autoUpdateNextAt - now);
    const totalSeconds = Math.ceil(remainingMs / 1000);
    if (totalSeconds >= 60) {
      const minutes = Math.ceil(totalSeconds / 60);
      return `Next update in ${minutes}m`;
    }
    return `Next update in ${totalSeconds}s`;
  }, [autoUpdateNextAt, now]);

  const updatedLabel = useMemo(() => {
    if (!lastUpdatedAt) return null;
    return `Updated ${formatRelativeTime(now - lastUpdatedAt)}`;
  }, [lastUpdatedAt, now]);

  const cooldownRemainingMs = Math.max(0, (refreshCooldownEndsAt ?? 0) - now);
  const onCooldown =
    !isRefreshing && cooldownRemainingMs > 0 && Boolean(refreshCooldownEndsAt);
  const cooldownLabel = useMemo(() => {
    if (!onCooldown) return undefined;
    const minutes = Math.ceil(cooldownRemainingMs / 60_000);
    return `Refresh again in ${minutes}m`;
  }, [onCooldown, cooldownRemainingMs]);

  return (
    <div className="flex justify-between items-center h-8 pt-1.5 border-t">
      <div className="flex items-center gap-1.5 min-w-0">
        <VersionDisplay
          updateStatus={updateStatus}
          onUpdateInstall={onUpdateInstall}
          onUpdateCheck={onUpdateCheck}
        />
        {updatedLabel && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {updatedLabel}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {onRefreshAll && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={isRefreshing || onCooldown}
            onClick={(event) => {
              event.currentTarget.blur();
              onRefreshAll();
            }}
            title={
              isRefreshing
                ? "Refreshing..."
                : onCooldown
                  ? cooldownLabel
                  : "Refresh Now"
            }
            aria-label="Refresh Now"
          >
            {onCooldown ? (
              <Hourglass className="size-3" />
            ) : (
              <RefreshCw className={`size-3 ${isRefreshing ? "animate-spin" : ""}`} />
            )}
          </Button>
        )}
        {autoUpdateNextAt !== null && onRefreshAll ? (
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget.blur()
              onRefreshAll()
            }}
            className="text-xs text-muted-foreground tabular-nums hover:text-foreground transition-colors cursor-pointer"
            title="Refresh now"
          >
            {countdownLabel}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground tabular-nums">
            {countdownLabel}
          </span>
        )}
      </div>
    </div>
  );
}
