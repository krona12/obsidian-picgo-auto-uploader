import { Modal, Notice, type App } from "obsidian";
import type { JobState } from "../domain";
import type { ControllerSnapshot, ScanResult } from "../obsidian/controller";
import type { PicGoClient } from "../picgo-client";
import type { EnqueueResult } from "../upload-queue";
import { resolveLocale, t, type SupportedLocale } from "../i18n";

export interface StatusModalActions {
  snapshot(): ControllerSnapshot;
  subscribe(listener: (snapshot: ControllerSnapshot) => void): () => void;
  isEnabled(): boolean;
  heartbeat(signal: AbortSignal): ReturnType<PicGoClient["heartbeat"]>;
  scanNow(): Promise<ScanResult>;
  retrySafeFailures(): Promise<EnqueueResult[]>;
  retry(
    path: string,
    options?: { acknowledgeUncertain?: boolean },
  ): Promise<EnqueueResult>;
  cancelPending(): Promise<void>;
  clearTerminalHistory(): Promise<void>;
  exportDiagnostics(): string;
  openSettings(): void;
}

type Filter =
  "all" | "success" | "failed" | "uncertain" | "skipped" | "cancelled";
const pendingStates = new Set<JobState>([
  "queued",
  "waiting-stable",
  "discovering-references",
  "uploading",
  "rewriting",
  "verifying",
  "deleting",
]);

const failureCopy = new Map<string, Parameters<typeof t>[1]>([
  ["aborted", "failure.cancelled"],
  ["ineligible-path", "failure.path"],
  ["invalid-path", "failure.path"],
  ["source-unavailable", "failure.path"],
  ["file-missing", "failure.path"],
  ["source-changed", "failure.path"],
  ["invalid-target", "failure.path"],
  ["file-too-large", "failure.tooLarge"],
  ["invalid-stat", "failure.stability"],
  ["invalid-options", "failure.stability"],
  ["stability-timeout", "failure.stability"],
  ["orphan", "failure.orphan"],
  ["discovery-blocked", "failure.reference"],
  ["discovery-failed", "failure.reference"],
  ["missing-cache", "failure.reference"],
  ["unresolved-destination", "failure.reference"],
  ["unsupported-dependency", "failure.reference"],
  ["unsupported-syntax", "failure.reference"],
  ["metadata-mismatch", "failure.reference"],
  ["unsafe-markdown-context", "failure.reference"],
  ["note-missing", "failure.reference"],
  ["read-failed", "failure.reference"],
  ["http-failure", "failure.upload"],
  ["invalid-response", "failure.upload"],
  ["picgo-failure", "failure.upload"],
  ["invalid-result", "failure.upload"],
  ["invalid-items", "failure.upload"],
  ["invalid-settings", "failure.upload"],
  ["transport-failure", "failure.upload"],
  ["invalid-request", "failure.upload"],
  ["response-too-large", "failure.upload"],
  ["connection-refused", "failure.upload"],
  ["timeout", "failure.upload"],
  ["disconnected", "failure.upload"],
  ["invalid-saved-url", "failure.upload"],
  ["snapshot-cleanup-failed", "failure.cleanup"],
  ["interrupted-upload", "failure.upload"],
  ["worker-uncertain", "failure.upload"],
  ["invalid-remote-url", "failure.rewrite"],
  ["mixed-notes", "failure.rewrite"],
  ["overlapping-edits", "failure.rewrite"],
  ["stale-offsets", "failure.rewrite"],
  ["process-failed", "failure.rewrite"],
  ["metadata-refresh-timeout", "failure.verify"],
  ["refresh-superseded", "failure.verify"],
  ["refresh-untracked", "failure.verify"],
  ["local-references-remain", "failure.verify"],
  ["worker-failed", "failure.lifecycle"],
  ["worker-incomplete", "failure.lifecycle"],
  ["persistence-failure", "failure.lifecycle"],
  ["queue-full", "failure.lifecycle"],
  ["not-retryable", "failure.lifecycle"],
  ["operation-failed", "failure.generic"],
]);

export class StatusModal extends Modal {
  private readonly locale: SupportedLocale;
  private snapshotValue: ControllerSnapshot;
  private release: (() => void) | undefined;
  private heartbeatAbort: AbortController | undefined;
  private picgo: "loading" | "online" | "offline" = "loading";
  private filter: Filter = "all";
  private readonly confirming = new Set<string>();
  private readonly busy = new Set<string>();
  private active = false;

  constructor(
    app: App,
    private readonly actions: StatusModalActions,
    locale?: string,
  ) {
    super(app);
    this.locale = resolveLocale(locale);
    this.snapshotValue = actions.snapshot();
  }

  onOpen(): void {
    this.active = true;
    this.snapshotValue = this.actions.snapshot();
    this.render();
    this.release = this.actions.subscribe((snapshot) => {
      this.snapshotValue = snapshot;
      this.render();
    });
    const controller = new AbortController();
    this.heartbeatAbort = controller;
    void this.actions
      .heartbeat(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          this.picgo = result.ok ? "online" : "offline";
          this.render();
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.picgo = "offline";
          this.render();
        }
      });
  }

  onClose(): void {
    this.active = false;
    this.heartbeatAbort?.abort();
    this.heartbeatAbort = undefined;
    this.release?.();
    this.release = undefined;
    this.confirming.clear();
    this.busy.clear();
    this.contentEl.replaceChildren();
  }

  private render(): void {
    if (!this.active) return;
    this.contentEl.replaceChildren();
    this.contentEl.className = "picgo-auto-uploader-status-modal";
    const heading = document.createElement("h2");
    heading.textContent = t(this.locale, "status.title");
    this.contentEl.append(heading);
    this.renderSummary();
    this.renderActions();
    this.renderFilters();
    this.renderJobs();
  }

  private renderSummary(): void {
    const summary = document.createElement("section");
    summary.className = "picgo-auto-uploader-summary";
    const pending = this.snapshotValue.jobs.filter((job) =>
      pendingStates.has(job.state),
    ).length;
    const lastSuccess = this.snapshotValue.jobs
      .filter((job) => job.state === "trashed")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.updatedAt;
    const values = [
      this.actions.isEnabled()
        ? t(this.locale, "status.automationOn")
        : t(this.locale, "status.automationOff"),
      this.picgo === "online"
        ? t(this.locale, "status.picgoOnline")
        : this.picgo === "offline"
          ? t(this.locale, "status.picgoOffline")
          : t(this.locale, "common.loading"),
      t(this.locale, "status.queueDepth", { count: pending }),
      t(this.locale, "status.lastScan", {
        time: this.time(this.snapshotValue.lastScanTime),
      }),
      t(this.locale, "status.lastSuccess", { time: this.time(lastSuccess) }),
    ];
    for (const value of values) {
      const card = document.createElement("div");
      card.className = "picgo-auto-uploader-summary-card";
      card.textContent = value;
      summary.append(card);
    }
    this.contentEl.append(summary);
  }

  private renderActions(): void {
    const row = document.createElement("div");
    row.className = "picgo-auto-uploader-actions";
    this.action(row, "scan", "status.scan", () => this.actions.scanNow());
    this.action(row, "retry-safe", "status.retrySafe", () =>
      this.actions.retrySafeFailures(),
    );
    this.action(row, "cancel", "common.cancel", () =>
      this.actions.cancelPending(),
    );
    this.action(row, "export", "status.export", () => this.download());
    this.action(row, "clear", "status.clear", () =>
      this.actions.clearTerminalHistory(),
    );
    this.action(row, "settings", "status.openSettings", () =>
      this.actions.openSettings(),
    );
    const explanation = document.createElement("span");
    explanation.className = "picgo-auto-uploader-muted";
    explanation.textContent = t(this.locale, "status.clearDesc");
    row.append(explanation);
    this.contentEl.append(row);
  }

  private renderFilters(): void {
    const group = document.createElement("div");
    group.className = "picgo-auto-uploader-filters";
    group.setAttribute("role", "group");
    const filters: Array<[Filter, Parameters<typeof t>[1]]> = [
      ["all", "status.filterAll"],
      ["success", "status.filterSuccess"],
      ["failed", "status.filterFailed"],
      ["uncertain", "status.filterUncertain"],
      ["skipped", "status.filterSkipped"],
      ["cancelled", "status.filterCancelled"],
    ];
    for (const [filter, label] of filters) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = t(this.locale, label);
      button.setAttribute("aria-pressed", String(this.filter === filter));
      button.addEventListener("click", () => {
        this.filter = filter;
        this.render();
      });
      group.append(button);
    }
    this.contentEl.append(group);
  }

  private renderJobs(): void {
    const jobs = [...this.snapshotValue.jobs]
      .filter((job) => {
        if (this.filter === "all") return true;
        if (this.filter === "success") return job.state === "trashed";
        return job.state === this.filter;
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const list = document.createElement("section");
    list.className = "picgo-auto-uploader-jobs";
    if (!jobs.length) {
      const empty = document.createElement("p");
      empty.className = "picgo-auto-uploader-empty";
      empty.textContent = t(this.locale, "status.empty");
      list.append(empty);
    }
    for (const job of jobs) {
      const row = document.createElement("article");
      row.className = "picgo-auto-uploader-job";
      row.dataset.state = job.state;
      const name = document.createElement("strong");
      name.textContent = job.vaultPath.split("/").at(-1) ?? "";
      const status = document.createElement("span");
      status.textContent = t(
        this.locale,
        `job.${job.state}` as Parameters<typeof t>[1],
      );
      const details = document.createElement("span");
      details.className = "picgo-auto-uploader-muted";
      details.textContent = `${this.time(job.updatedAt)} · ${t(this.locale, "status.rewritten", { count: job.rewrittenNotePaths.length })}`;
      row.append(name, status, details);
      if (job.failure) {
        const failure = document.createElement("span");
        const copy = failureCopy.get(job.failure.code) ?? "failure.generic";
        failure.textContent = `${t(this.locale, `stage.${job.failure.stage}` as Parameters<typeof t>[1])}: ${t(this.locale, copy)}${job.failure.notePath ? ` · ${job.failure.notePath}` : ""}`;
        row.append(failure);
        if (job.failure.retry === "safe" && job.state !== "uncertain")
          this.jobAction(row, "retry", job.vaultPath, "common.retry", () =>
            this.actions.retry(job.vaultPath),
          );
        if (job.state === "uncertain") {
          if (this.confirming.has(job.vaultPath))
            this.jobAction(
              row,
              "confirm-uncertain",
              job.vaultPath,
              "status.uncertainConfirm",
              () =>
                this.actions.retry(job.vaultPath, {
                  acknowledgeUncertain: true,
                }),
            );
          else
            this.jobAction(
              row,
              "retry-uncertain",
              job.vaultPath,
              "status.uncertainWarn",
              () => {
                this.confirming.add(job.vaultPath);
                this.render();
              },
            );
        }
      }
      list.append(row);
    }
    this.contentEl.append(list);
  }

  private action(
    parent: HTMLElement,
    id: string,
    label: Parameters<typeof t>[1],
    operation: () => unknown | Promise<unknown>,
  ): void {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = id;
    button.textContent = t(this.locale, label);
    button.disabled = this.busy.has(id);
    button.addEventListener("click", () => void this.run(id, operation));
    parent.append(button);
  }

  private jobAction(
    parent: HTMLElement,
    action: string,
    path: string,
    label: Parameters<typeof t>[1],
    operation: () => unknown | Promise<unknown>,
  ): void {
    const key = `${action}:${path}`;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = t(this.locale, label);
    button.disabled = this.busy.has(key);
    button.addEventListener("click", () => void this.run(key, operation));
    parent.append(button);
  }

  private async run(
    key: string,
    operation: () => unknown | Promise<unknown>,
  ): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    this.render();
    try {
      await operation();
    } catch {
      new Notice(t(this.locale, "status.operationFailed"));
    } finally {
      this.busy.delete(key);
      this.render();
    }
  }

  private download(): void {
    try {
      const blob = new Blob([this.actions.exportDiagnostics()], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "picgo-auto-uploader-diagnostics.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      new Notice(t(this.locale, "status.downloadFailed"));
    }
  }

  private time(value: number | null | undefined): string {
    return value
      ? new Date(value).toLocaleString(this.locale)
      : t(this.locale, "status.never");
  }
}
