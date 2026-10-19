/* eslint-disable @typescript-eslint/no-explicit-any -- Deliberately mirrors the broad Obsidian runtime boundary. */
export interface MockCommand {
  id: string;
  name: string;
  callback: () => void | Promise<void>;
}

export const moment = { locale: () => "en" };
export const apiVersion = "1.7.2";
export const Platform = { isDesktopApp: true };

export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class Plugin {
  app: any;
  manifest: any;
  commands: MockCommand[] = [];
  ribbons: Array<{ icon: string; title: string; callback: () => void }> = [];
  settingTabs: unknown[] = [];
  statusItems: HTMLElement[] = [];
  registeredViews: unknown[] = [];
  data: unknown = null;
  saveCalls: unknown[] = [];
  constructor(
    app: any = {},
    manifest: any = { id: "picgo-auto-uploader", version: "0.1.0" },
  ) {
    this.app = app;
    this.manifest = manifest;
  }
  loadData(): Promise<unknown> {
    return Promise.resolve(this.data);
  }
  saveData(value: unknown): Promise<void> {
    this.data = structuredClone(value);
    this.saveCalls.push(structuredClone(value));
    return Promise.resolve();
  }
  addCommand(command: MockCommand): MockCommand {
    this.commands.push(command);
    return command;
  }
  addRibbonIcon(
    icon: string,
    title: string,
    callback: () => void,
  ): HTMLElement {
    this.ribbons.push({ icon, title, callback });
    return document.createElement("div");
  }
  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }
  addStatusBarItem(): HTMLElement {
    const item = document.createElement("div");
    this.statusItems.push(item);
    return item;
  }
  registerView(...args: unknown[]): void {
    this.registeredViews.push(args);
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(
    public app: any,
    public plugin: any,
  ) {}
  display(): void {}
  hide(): void {}
}

export class Modal {
  contentEl = document.createElement("div");
  opened = false;
  constructor(public app: any) {}
  open(): void {
    this.opened = true;
    this.onOpen();
  }
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

class TextComponent {
  inputEl = document.createElement("input");
  constructor(parent: HTMLElement) {
    parent.append(this.inputEl);
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }
  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }
}

class TextAreaComponent {
  inputEl = document.createElement("textarea");
  constructor(parent: HTMLElement) {
    parent.append(this.inputEl);
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }
  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }
}

class ToggleComponent {
  toggleEl = document.createElement("input");
  constructor(parent: HTMLElement) {
    this.toggleEl.type = "checkbox";
    parent.append(this.toggleEl);
  }
  setValue(value: boolean): this {
    this.toggleEl.checked = value;
    return this;
  }
  onChange(callback: (value: boolean) => void): this {
    this.toggleEl.addEventListener("change", () =>
      callback(this.toggleEl.checked),
    );
    return this;
  }
}

class ButtonComponent {
  buttonEl = document.createElement("button");
  constructor(parent: HTMLElement) {
    parent.append(this.buttonEl);
  }
  setButtonText(value: string): this {
    this.buttonEl.textContent = value;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setDisabled(value: boolean): this {
    this.buttonEl.disabled = value;
    return this;
  }
  onClick(callback: () => void | Promise<void>): this {
    this.buttonEl.addEventListener("click", () => {
      void callback();
    });
    return this;
  }
}

export class Setting {
  settingEl = document.createElement("div");
  nameEl = document.createElement("div");
  descEl = document.createElement("div");
  controlEl = document.createElement("div");
  constructor(parent: HTMLElement) {
    this.settingEl.className = "setting-item";
    this.nameEl.className = "setting-item-name";
    this.descEl.className = "setting-item-description";
    this.controlEl.className = "setting-item-control";
    this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
    parent.append(this.settingEl);
  }
  setName(value: string): this {
    this.nameEl.textContent = value;
    return this;
  }
  setDesc(value: string): this {
    this.descEl.textContent = value;
    return this;
  }
  addText(callback: (component: TextComponent) => void): this {
    callback(new TextComponent(this.controlEl));
    return this;
  }
  addTextArea(callback: (component: TextAreaComponent) => void): this {
    callback(new TextAreaComponent(this.controlEl));
    return this;
  }
  addToggle(callback: (component: ToggleComponent) => void): this {
    callback(new ToggleComponent(this.controlEl));
    return this;
  }
  addButton(callback: (component: ButtonComponent) => void): this {
    callback(new ButtonComponent(this.controlEl));
    return this;
  }
}

export type App = any;
export type TFile = any;
export type EventRef = object;
export type Vault = any;
export type MetadataCache = any;
export type CachedMetadata = any;
export type DataAdapter = any;
export type TAbstractFile = any;
