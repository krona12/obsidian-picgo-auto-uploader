import type { ControllerSnapshot } from "../obsidian/controller";
import { isTerminalState } from "../job-store";
import { resolveLocale, t, type SupportedLocale } from "../i18n";

export interface StatusBarActions {
  snapshot(): ControllerSnapshot;
  subscribe(listener: (snapshot: ControllerSnapshot) => void): () => void;
  isEnabled(): boolean;
  openStatus(): void;
}

export class StatusBarPresenter {
  private release: (() => void) | undefined;
  private readonly locale: SupportedLocale;
  private readonly activate = () => this.actions.openStatus();
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.activate();
  };

  constructor(
    private readonly element: HTMLElement,
    private actions: StatusBarActions,
    locale?: string,
  ) {
    this.locale = resolveLocale(locale);
    element.classList.add("picgo-auto-uploader-status-bar");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.addEventListener("click", this.activate);
    element.addEventListener("keydown", this.keydown);
    this.bind(actions);
  }

  bind(actions: StatusBarActions): void {
    this.release?.();
    this.actions = actions;
    this.render(actions.snapshot());
    this.release = actions.subscribe((snapshot) => this.render(snapshot));
  }

  destroy(): void {
    this.release?.();
    this.release = undefined;
    this.element.removeEventListener("click", this.activate);
    this.element.removeEventListener("keydown", this.keydown);
    this.element.replaceChildren();
  }

  private render(snapshot: ControllerSnapshot): void {
    const attention =
      (snapshot.counts.failed ?? 0) + (snapshot.counts.uncertain ?? 0);
    const pending = snapshot.jobs.filter(
      (job) => !isTerminalState(job.state),
    ).length;
    const text = attention
      ? t(this.locale, "statusbar.attention", { count: attention })
      : pending
        ? t(this.locale, "statusbar.pending", { count: pending })
        : !this.actions.isEnabled()
          ? t(this.locale, "statusbar.disabled")
          : snapshot.state === "stopped"
            ? t(this.locale, "statusbar.stopped")
            : t(this.locale, "statusbar.ready");
    this.element.textContent = text;
    this.element.title = t(this.locale, "statusbar.open");
    this.element.setAttribute(
      "aria-label",
      `${text}. ${t(this.locale, "statusbar.open")}`,
    );
    this.element.dataset.state = attention
      ? "attention"
      : pending
        ? "pending"
        : snapshot.state;
  }
}
