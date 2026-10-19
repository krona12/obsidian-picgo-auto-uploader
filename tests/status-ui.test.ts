// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerSnapshot } from "../src/obsidian/controller";
import { StatusBarPresenter } from "../src/ui/status-bar";
import { StatusModal, type StatusModalActions } from "../src/ui/status-modal";

const empty: ControllerSnapshot = Object.freeze({
  state: "running",
  counts: {},
  lastScanTime: null,
  lastScan: null,
  jobs: [],
  logs: [],
});

function actions(
  overrides: Partial<StatusModalActions> = {},
): StatusModalActions {
  return {
    snapshot: () => empty,
    subscribe: () => () => {},
    isEnabled: () => true,
    heartbeat: async () => ({ ok: true, value: undefined }),
    scanNow: vi.fn(async () => ({ eligible: 0, enqueued: 0, failed: 0 })),
    retrySafeFailures: vi.fn(async () => []),
    retry: vi.fn(async () => ({
      ok: true as const,
      value: "enqueued" as const,
    })),
    cancelPending: vi.fn(async () => {}),
    clearTerminalHistory: vi.fn(async () => {}),
    exportDiagnostics: vi.fn(() => "{}"),
    openSettings: vi.fn(),
    ...overrides,
  };
}

describe("status UI", () => {
  beforeEach(() => document.body.replaceChildren());

  it("renders empty status immediately and keeps manual scan available when automation is off", () => {
    const modal = new StatusModal(
      {} as never,
      actions({ isEnabled: () => false }),
      "en",
    );
    modal.open();
    expect(modal.contentEl.textContent).toContain("Automation disabled");
    expect(modal.contentEl.textContent).toContain("No jobs yet");
    expect(
      modal.contentEl.querySelector<HTMLButtonElement>(
        'button[data-action="scan"]',
      )!.disabled,
    ).toBe(false);
  });

  it("requires a second explicit action before retrying an uncertain job", async () => {
    const retry = vi.fn(async () => ({
      ok: true as const,
      value: "enqueued" as const,
    }));
    const snapshot: ControllerSnapshot = Object.freeze({
      ...empty,
      counts: { uncertain: 1 },
      jobs: [
        Object.freeze({
          vaultPath: "attachments/private.png",
          state: "uncertain",
          createdAt: 1,
          updatedAt: 2,
          rewrittenNotePaths: [],
          rewrittenReferenceCount: 0,
          failure: Object.freeze({
            code: "timeout",
            stage: "upload",
            message: "safe",
            retry: "uncertain",
          }),
        }),
      ],
    });
    const modal = new StatusModal(
      {} as never,
      actions({ snapshot: () => snapshot, retry }),
      "en",
    );
    modal.open();
    modal.contentEl
      .querySelector<HTMLButtonElement>(
        'button[data-action="retry-uncertain"]',
      )!
      .click();
    expect(retry).not.toHaveBeenCalled();
    modal.contentEl
      .querySelector<HTMLButtonElement>(
        'button[data-action="confirm-uncertain"]',
      )!
      .click();
    await Promise.resolve();
    expect(retry).toHaveBeenCalledWith("attachments/private.png", {
      acknowledgeUncertain: true,
    });
  });

  it.each([
    ["en", "The operation could not be completed safely."],
    ["zh-CN", "操作未能安全完成。"],
  ])(
    "renders generic localized copy for unsafe unknown failure codes in %s",
    (locale, expected) => {
      const sentinel = "Authorization: Bearer secret C:\\private\\photo.png";
      const snapshot: ControllerSnapshot = Object.freeze({
        ...empty,
        counts: { failed: 1 },
        jobs: [
          Object.freeze({
            vaultPath: "attachments/private.png",
            state: "failed",
            createdAt: 1,
            updatedAt: 2,
            rewrittenNotePaths: [],
            rewrittenReferenceCount: 0,
            failure: Object.freeze({
              code: sentinel,
              stage: "upload",
              message: sentinel,
              retry: "safe",
            }),
          }),
        ],
      });
      const modal = new StatusModal(
        {} as never,
        actions({ snapshot: () => snapshot }),
        locale,
      );
      modal.open();
      expect(modal.contentEl.textContent).toContain(expected);
      expect(modal.contentEl.textContent).not.toContain("Authorization");
      expect(modal.contentEl.textContent).not.toContain("C:\\private");
      modal.close();
    },
  );

  it.each([
    ["en", "The rewritten references could not be verified."],
    ["zh-CN", "无法验证改写后的引用。"],
  ])(
    "renders reference-state races as verification failures in %s",
    (locale, expected) => {
      const snapshot: ControllerSnapshot = Object.freeze({
        ...empty,
        counts: { failed: 1 },
        jobs: [
          Object.freeze({
            vaultPath: "attachments/image.png",
            state: "failed",
            createdAt: 1,
            updatedAt: 2,
            rewrittenNotePaths: ["note.md"],
            rewrittenReferenceCount: 1,
            failure: Object.freeze({
              code: "reference-state-changed",
              stage: "verify",
              message: "safe",
              retry: "safe",
            }),
          }),
        ],
      });
      const modal = new StatusModal(
        {} as never,
        actions({ snapshot: () => snapshot }),
        locale,
      );
      modal.open();
      expect(modal.contentEl.textContent).toContain(expected);
      modal.close();
    },
  );

  it("aborts heartbeat and unsubscribes on close", () => {
    let signal: AbortSignal | undefined;
    const unsubscribe = vi.fn();
    const modal = new StatusModal(
      {} as never,
      actions({
        heartbeat: (_signal) => {
          signal = _signal;
          return new Promise(() => {});
        },
        subscribe: () => unsubscribe,
      }),
      "en",
    );
    modal.open();
    modal.close();
    expect(signal?.aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it("does not repopulate the closed modal when a manual action settles later", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const modal = new StatusModal(
      {} as never,
      actions({
        scanNow: vi.fn(() =>
          pending.then(() => ({ eligible: 0, enqueued: 0, failed: 0 })),
        ),
      }),
      "en",
    );
    modal.open();
    modal.contentEl
      .querySelector<HTMLButtonElement>('button[data-action="scan"]')!
      .click();
    modal.close();
    finish();
    await pending;
    await Promise.resolve();
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it("status bar uses attention priority and is keyboard operable", () => {
    const element = document.createElement("div");
    let listener: ((snapshot: ControllerSnapshot) => void) | undefined;
    const unsubscribe = vi.fn();
    const open = vi.fn();
    const presenter = new StatusBarPresenter(
      element,
      {
        snapshot: () => empty,
        subscribe: (next) => {
          listener = next;
          return unsubscribe;
        },
        isEnabled: () => true,
        openStatus: open,
      },
      "en",
    );
    listener?.(Object.freeze({ ...empty, counts: { queued: 4, failed: 1 } }));
    expect(element.textContent).toContain("Needs attention");
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(open).toHaveBeenCalledOnce();
    presenter.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
