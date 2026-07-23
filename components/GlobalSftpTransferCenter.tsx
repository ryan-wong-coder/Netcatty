import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCopy,
  FolderOpen,
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
import { formatFileSize } from "../application/state/sftp/utils";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type GlobalTransferBucket = "active" | "queued" | "paused" | "failed" | "completed";

export function getGlobalTransferBucket(task: Pick<TransferTask, "status">): GlobalTransferBucket {
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

const BUCKETS: readonly GlobalTransferBucket[] = ["active", "queued", "paused", "failed", "completed"];

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
  const canPause = task.resumable !== false && task.status === "transferring" && canControl;
  const canResume = (
    ["paused", "interrupted", "attention"].includes(task.status)
    || (task.status === "failed" && task.resumable !== false && (task.checkpointBytes ?? 0) > 0)
  ) && (canControl || task.status === "interrupted" || task.status === "attention");
  const canCancel = ["pending", "queued", "transferring", "pausing", "paused", "interrupted", "attention"].includes(task.status) && canControl;
  const canRetry = task.status === "failed" && task.retryable !== false && canControl;
  const isTerminal = ["completed", "failed", "cancelled"].includes(task.status);
  const directionIcon = task.direction === "download"
    ? <ArrowDownToLine size={15} />
    : <ArrowUpFromLine size={15} />;

  const openTarget = () => {
    window.dispatchEvent(new CustomEvent("netcatty:open-sftp-transfer-target", { detail: task }));
  };
  const resumeTask = () => {
    openTarget();
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
        <button type="button" className="min-w-0 flex-1 text-left" onClick={openTarget}>
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
          <TransferAction label={t("sftp.transfers.openTargetFolder")} onClick={openTarget}>
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
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className={cn((task.status === "failed" || task.status === "attention") && "text-destructive")}>
          {task.error || task.pauseUnavailableReason || (task.phase ? t(`sftp.transferCenter.phase.${task.phase}`) : t(statusLabelKey(task.status)))}
        </span>
        <span className="font-mono">
          {formatFileSize(task.transferredBytes)} / {task.totalBytes > 0 ? formatFileSize(task.totalBytes) : "—"}
          {task.speed > 0 ? ` · ${formatFileSize(task.speed)}/s` : ""}
        </span>
      </div>
      {task.status === "attention" && task.conflict && canControl && (
        <div className="mt-2 flex flex-wrap justify-end gap-1">
          {(["stop", "skip", "duplicate", "merge", "replace"] as const).map((action) => (
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
          {(task.conflict.applyToAllCount ?? 0) > 1 && (["skip", "duplicate", "merge", "replace"] as const).map((action) => (
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
      )}
    </div>
  );
}

export function GlobalSftpTransferCenter() {
  const { t } = useI18n();
  const snapshot = useSftpTransferCenter();
  const [bucket, setBucket] = useState<GlobalTransferBucket>("active");
  const [showBackground, setShowBackground] = useState(false);
  const badge = getGlobalTransferBadge(snapshot.tasks);
  const counts = useMemo(() => Object.fromEntries(BUCKETS.map((item) => [
    item,
    snapshot.tasks.filter((task) => !task.parentTaskId && getGlobalTransferBucket(task) === item).length,
  ])) as Record<GlobalTransferBucket, number>, [snapshot.tasks]);
  const bucketTasks = useMemo(() => snapshot.tasks
    .filter((task) => !task.parentTaskId && getGlobalTransferBucket(task) === bucket)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.startTime - a.startTime), [bucket, snapshot.tasks]);
  const { visible, collapsed } = splitBackgroundTransfers(bucketTasks);
  const displayed = showBackground ? [...visible, ...collapsed] : visible;

  const pauseAll = () => {
    for (const task of snapshot.tasks) {
      if (["pending", "queued", "transferring"].includes(task.status) && task.resumable !== false) void sftpTransferCenterStore.pause(task.id);
    }
  };
  const resumeAll = () => {
    for (const task of snapshot.tasks) {
      if (task.status === "paused" || task.status === "interrupted") void sftpTransferCenterStore.resume(task.id);
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
              <ArrowDownToLine size={15} />
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
        className="w-[min(760px,calc(100vw-24px))] overflow-hidden p-0 app-no-drag"
        data-section="global-sftp-transfer-center"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{t("sftp.transferCenter.title")}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{t("sftp.transferCenter.subtitle")}</div>
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
                "border-b-2 px-3 py-1.5 text-[11px] transition-colors",
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
              {badge.hasAttention && bucket !== "failed" ? <AlertCircle size={22} /> : <ArrowDownToLine size={22} />}
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
