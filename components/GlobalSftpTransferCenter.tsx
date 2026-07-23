import {
  AlertCircle,
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpFromLine,
  ClipboardCopy,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import React, { useMemo, useState } from "react";

import { useI18n } from "../application/i18n/I18nProvider";
import {
  sftpTransferCenterStore,
  useSftpTransferCenter,
} from "../application/state/sftpTransferCenterStore";
import type { TransferTask } from "../domain/models";
import { canReplaceSftpConflict } from "../domain/sftpConflict";
import { estimateTransferEtaSeconds, formatFileSize, formatTransferEta } from "../application/state/sftp/utils";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type GlobalTransferBucket = "all" | "active" | "queued" | "paused" | "failed" | "completed";

export function getGlobalTransferBucket(task: Pick<TransferTask, "status" | "reconnectRequired">): GlobalTransferBucket {
  // Reconnect/resume preparation should stay visible with the unfinished work.
  if (task.status === "pending" && task.reconnectRequired) return "paused";
  if (task.status === "transferring" || task.status === "pausing") return "active";
  if (task.status === "pending" || task.status === "queued") return "queued";
  if (task.status === "paused" || task.status === "interrupted" || task.status === "attention") return "paused";
  if (task.status === "failed") return "failed";
  return "completed";
}

export function getGlobalTransferBadge(tasks: readonly TransferTask[]) {
  const topLevelTasks = tasks.filter((task) => !task.parentTaskId);
  return {
    count: topLevelTasks.filter((task) => ["pending", "queued", "transferring", "pausing"].includes(task.status)).length,
    hasAttention: topLevelTasks.some((task) => task.status === "attention" || task.status === "failed"),
  };
}

export function splitBackgroundTransfers(tasks: readonly TransferTask[]) {
  const collapsed = tasks.filter((task) => task.background && task.status === "completed");
  const collapsedIds = new Set(collapsed.map((task) => task.id));
  return {
    visible: tasks.filter((task) => !collapsedIds.has(task.id)),
    collapsed,
  };
}

const BUCKETS: readonly GlobalTransferBucket[] = ["all", "active", "queued", "paused", "failed", "completed"];

export function getTasksForGlobalTransferBucket(
  tasks: readonly TransferTask[],
  bucket: GlobalTransferBucket,
): TransferTask[] {
  return tasks.filter((task) => !task.parentTaskId && (bucket === "all" || getGlobalTransferBucket(task) === bucket));
}

function statusLabelKey(status: TransferTask["status"]): string {
  return `sftp.transferCenter.status.${status}`;
}

function TransferAction({ label, onClick, children, destructive = false }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7", destructive && "text-destructive hover:text-destructive")}
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function TransferRow({ task }: { task: TransferTask }) {
  const { t } = useI18n();
  const percent = task.totalBytes > 0
    ? Math.max(0, Math.min(100, (task.transferredBytes / task.totalBytes) * 100))
    : 0;
  const canControl = sftpTransferCenterStore.canControl(task.id);
  // Keep the play button as a spinner for the whole reconnect window, not only
  // the brief "pending" status before a dedicated session opens.
  const isResuming = task.reconnectRequired === true
    && ["pending", "queued", "transferring"].includes(task.status)
    && !task.error;
  const canPause = task.resumable !== false && task.status === "transferring" && canControl && !isResuming;
  // Orphaned tasks after app restart (interrupted / attention / paused without a
  // live panel owner) must still expose resume/cancel from the global center.
  // Conflict rows must use resolveConflict — Resume would overwrite blindly.
  const canResume = !isResuming && !task.conflict && (
    ["paused", "interrupted", "attention"].includes(task.status)
    || (task.status === "failed" && task.resumable !== false && (task.checkpointBytes ?? 0) > 0)
  ) && canControl;
  const canCancel = ["pending", "queued", "transferring", "pausing", "paused", "interrupted", "attention"].includes(task.status) && canControl;
  const canRetry = task.status === "failed" && task.retryable !== false && canControl;
  const isTerminal = ["completed", "failed", "cancelled"].includes(task.status);
  // Only show phase while the transfer is actually running. After restart,
  // stale phase:"transferring" must not override interrupted/paused status.
  const statusText = task.error
    || task.pauseUnavailableReason
    || (isResuming
      ? t("sftp.transferCenter.status.resuming")
      : (
        task.phase
        && (task.status === "transferring" || task.status === "pausing")
          ? t(`sftp.transferCenter.phase.${task.phase}`)
          : t(statusLabelKey(task.status))
      ));
  const etaLabel = task.status === "transferring" && task.speed > 0 && task.totalBytes > 0
    ? formatTransferEta(estimateTransferEtaSeconds(task.totalBytes - task.transferredBytes, task.speed))
    : null;
  const directionIcon = task.direction === "download"
    ? <ArrowDownToLine size={15} />
    : <ArrowUpFromLine size={15} />;

  const openTarget = (forResume = false) => {
    window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", {
      detail: { task, forResume },
    }));
  };
  const resumeTask = () => {
    // Dedicated resume opens its own SFTP session; panel open is only a
    // fallback for server-to-server tasks and must not race the spinner state.
    if (task.direction === "remote-to-remote") {
      openTarget(true);
    }
    void sftpTransferCenterStore.resume(task.id);
  };

  return (
    <div
      className="border-b border-border/40 px-3 py-2.5 last:border-b-0 hover:bg-muted/30"
      data-section="global-sftp-transfer-row"
      data-transfer-status={task.status}
    >
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          {directionIcon}
        </div>
        <button type="button" className="min-w-0 flex-1 overflow-hidden text-left" onClick={() => openTarget()}>
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium">{task.fileName}</span>
            {task.background && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                {t("sftp.transferCenter.background")}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {`${task.sourceHostLabel ? `${task.sourceHostLabel}: ` : ""}${task.sourcePath} → ${task.targetHostLabel ? `${task.targetHostLabel}: ` : ""}${task.targetPath}`}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {isResuming && (
            <TransferAction label={t("sftp.transferCenter.status.resuming")} onClick={() => {}}>
              <Loader2 size={13} className="animate-spin text-primary" />
            </TransferAction>
          )}
          {canPause && (
            <TransferAction label={t("sftp.transferCenter.pause")} onClick={() => { void sftpTransferCenterStore.pause(task.id); }}>
              <Pause size={13} />
            </TransferAction>
          )}
          {canResume && (
            <TransferAction label={t("sftp.transferCenter.resume")} onClick={resumeTask}>
              <Play size={13} />
            </TransferAction>
          )}
          {task.status === "queued" && canControl && (
            <TransferAction label={t("sftp.transferCenter.prioritize")} onClick={() => { void sftpTransferCenterStore.prioritize(task.id); }}>
              <ArrowUpFromLine size={13} />
            </TransferAction>
          )}
          {canRetry && (
            <TransferAction label={t("sftp.transfers.retryAction")} onClick={() => { void sftpTransferCenterStore.retry(task.id); }}>
              <RefreshCw size={13} />
            </TransferAction>
          )}
          {isTerminal && (
            <TransferAction label={t("sftp.transfers.dismissAction")} onClick={() => sftpTransferCenterStore.dismiss(task.id)}>
              <Trash2 size={13} />
            </TransferAction>
          )}
          {canCancel && (
            <TransferAction destructive label={t("common.cancel")} onClick={() => { void sftpTransferCenterStore.cancel(task.id); }}>
              <X size={13} />
            </TransferAction>
          )}
          <TransferAction label={t("sftp.transfers.copyTargetPath")} onClick={() => { void navigator.clipboard.writeText(task.targetPath); }}>
            <ClipboardCopy size={13} />
          </TransferAction>
          <TransferAction label={t("sftp.transfers.openTargetFolder")} onClick={() => openTarget()}>
            <FolderOpen size={13} />
          </TransferAction>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-150",
              task.status === "failed" ? "bg-destructive" : task.status === "paused" || task.status === "interrupted" ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${task.status === "completed" ? 100 : percent}%` }}
          />
        </div>
        <span className="w-12 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {task.totalBytes > 0 ? `${percent.toFixed(1)}%` : "—"}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span className={cn("min-w-0 truncate", (task.status === "failed" || task.status === "attention") && "text-destructive")}>
          {statusText}
        </span>
        <span className="min-w-0 shrink truncate font-mono text-right">
          {formatFileSize(task.transferredBytes)} / {task.totalBytes > 0 ? formatFileSize(task.totalBytes) : "—"}
          {task.speed > 0 ? ` · ${formatFileSize(task.speed)}/s` : ""}
          {etaLabel ? ` · ${etaLabel}` : ""}
        </span>
      </div>
      {task.status === "attention" && task.conflict && canControl && (() => {
        const conflict = task.conflict!;
        const canMerge = conflict.isDirectory && conflict.existingType === "directory";
        const canReplace = canReplaceSftpConflict(conflict.isDirectory, conflict.existingType);
        const actions = [
          "stop",
          "skip",
          "duplicate",
          ...(canMerge ? (["merge"] as const) : []),
          ...(canReplace ? (["replace"] as const) : []),
        ] as const;
        const applyAllActions = [
          "skip",
          "duplicate",
          ...(canMerge ? (["merge"] as const) : []),
          ...(canReplace ? (["replace"] as const) : []),
        ] as const;
        return (
        <div className="mt-2 flex flex-wrap justify-end gap-1">
          {actions.map((action) => (
            <Button
              key={action}
              variant={action === "replace" ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => { void sftpTransferCenterStore.resolveConflict(task.id, action); }}
            >
              {t(`sftp.conflict.action.${action}`)}
            </Button>
          ))}
          {(conflict.applyToAllCount ?? 0) > 1 && applyAllActions.map((action) => (
            <Button
              key={`all-${action}`}
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => { void sftpTransferCenterStore.resolveConflict(task.id, action, true); }}
            >
              {t(`sftp.conflict.action.${action}`)} · {t("sftp.transferCenter.applyAll")}
            </Button>
          ))}
        </div>
        );
      })()}
    </div>
  );
}

export function GlobalSftpTransferCenter() {
  const { t } = useI18n();
  const snapshot = useSftpTransferCenter();
  const [bucket, setBucket] = useState<GlobalTransferBucket>("all");
  const [showBackground, setShowBackground] = useState(false);
  const badge = getGlobalTransferBadge(snapshot.tasks);
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((item) => [
    item,
    getTasksForGlobalTransferBucket(snapshot.tasks, item).length,
  ])) as Record<GlobalTransferBucket, number>, [snapshot.tasks]);
  const bucketTasks = useMemo(() => getTasksForGlobalTransferBucket(snapshot.tasks, bucket)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.startTime - a.startTime), [bucket, snapshot.tasks]);
  const { visible, collapsed } = splitBackgroundTransfers(bucketTasks);
  const displayed = showBackground ? [...visible, ...collapsed] : visible;

  const pauseAll = () => {
    for (const task of snapshot.tasks) {
      // Only top-level rows — children are driven by their parent directory job.
      if (task.parentTaskId) continue;
      // Skip dedicated reconnect spinner rows — pause cannot stop open/auth yet
      // and would only demote the UI while the stream continues.
      if (task.ownerId === "dedicated-resume" && task.reconnectRequired) continue;
      if (["pending", "queued", "transferring", "pausing"].includes(task.status) && task.resumable !== false) {
        void sftpTransferCenterStore.pause(task.id);
      }
    }
  };
  const resumeAll = () => {
    for (const task of snapshot.tasks) {
      // Resume parents only; child interrupted rows after restart are rebuilt
      // when the parent directory is re-adopted (avoids dual writers).
      if (task.parentTaskId) continue;
      if (task.conflict) continue;
      if (task.status === "paused" || task.status === "interrupted" || task.status === "attention") {
        void sftpTransferCenterStore.resume(task.id);
      }
    }
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn"
              aria-label={t("sftp.transferCenter.title")}
              data-section="global-sftp-transfer-toggle"
            >
              <ArrowDownUp size={15} />
              {badge.count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex min-h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] leading-3 text-primary-foreground">
                  {badge.count > 99 ? "99+" : badge.count}
                </span>
              )}
              {badge.count === 0 && badge.hasAttention && (
                <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-destructive" />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("sftp.transferCenter.title")}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        sideOffset={5}
        className="w-[min(460px,calc(100vw-24px))] overflow-hidden p-0 app-no-drag"
        data-section="global-sftp-transfer-center"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="min-w-0 pr-2 text-sm font-semibold">
            {t("sftp.transferCenter.title")}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={pauseAll}>
              <Pause size={12} className="mr-1" />{t("sftp.transferCenter.pauseAll")}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resumeAll}>
              <Play size={12} className="mr-1" />{t("sftp.transferCenter.resumeAll")}
            </Button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-border/50 bg-muted/30 px-3 pt-2">
          {BUCKETS.map((item) => (
            <button
              key={item}
              type="button"
              className={cn(
                "min-w-0 flex-1 truncate border-b-2 px-1.5 py-1.5 text-[11px] transition-colors",
                bucket === item ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setBucket(item)}
            >
              {t(`sftp.transferCenter.bucket.${item}`)}
              {counts[item] > 0 && <span className="ml-1 text-[10px]">{counts[item]}</span>}
            </button>
          ))}
        </div>

        <div className="max-h-[460px] overflow-auto">
          {displayed.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center text-muted-foreground">
              {badge.hasAttention && bucket !== "failed" && bucket !== "all" ? <AlertCircle size={22} /> : <ArrowDownUp size={22} />}
              <span className="mt-2 text-xs">{t("sftp.transferCenter.empty")}</span>
            </div>
          ) : displayed.map((task) => <TransferRow key={task.id} task={task} />)}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 px-3 py-2">
          <div>
            {collapsed.length > 0 && (
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowBackground((value) => !value)}>
                {showBackground
                  ? t("sftp.transferCenter.hideBackground")
                  : t("sftp.transferCenter.showBackground", { count: collapsed.length })}
              </Button>
            )}
          </div>
          {(bucket === "failed" || bucket === "completed") && counts[bucket] > 0 && (
            <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => sftpTransferCenterStore.clearTerminal(bucket === "failed" ? "failed" : "completed")}>
              <Trash2 size={11} className="mr-1" />{t("sftp.transferCenter.clear")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
