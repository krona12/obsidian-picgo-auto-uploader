export type SupportedLocale = "en" | "zh-CN";

const english = {
  "common.error": "Something went wrong.",
  "common.apply": "Apply settings",
  "common.reset": "Reset non-secret defaults",
  "common.openStatus": "Open status center",
  "common.retry": "Retry",
  "common.cancel": "Cancel pending work",
  "common.loading": "Loading…",
  "settings.title": "PicGo Auto Uploader",
  "settings.enabled": "Automatic processing",
  "settings.enabledDesc":
    "Only referenced images are uploaded. Local files are moved to Vault trash only after every rewrite is verified.",
  "settings.origin": "PicGo server",
  "settings.originDesc": "Base address of the PicGo HTTP service.",
  "settings.secret": "PicGo secret",
  "settings.secretDesc":
    "Optional bearer secret. Obsidian stores it locally in this plugin's data.json file.",
  "settings.test": "Test connection",
  "settings.testSuccess": "PicGo is reachable.",
  "settings.testFailure": "PicGo is unavailable.",
  "settings.folders": "Attachment folders",
  "settings.foldersDesc": "One Vault-relative folder per line.",
  "settings.extensions": "Image extensions",
  "settings.extensionsDesc": "Comma-separated extensions.",
  "settings.maxSize": "Maximum file size (MiB)",
  "settings.quiet": "Quiet period (seconds)",
  "settings.sampleInterval": "Stability sample interval (seconds)",
  "settings.sampleCount": "Stable observations",
  "settings.stabilityTimeout": "Stability timeout (seconds)",
  "settings.reconciliation": "Reconciliation interval (minutes)",
  "settings.requestTimeout": "Request timeout (seconds)",
  "settings.historyEntries": "History entries",
  "settings.historyDays": "History days",
  "settings.insecureWarning":
    "This plain HTTP server is not local. File paths and the optional secret could be exposed on the network.",
  "settings.insecureAck": "I understand and allow plain HTTP to this host",
  "settings.validation": "Check the highlighted setting.",
  "settings.saved": "Settings applied.",
  "settings.saveFailed": "Settings could not be saved.",
  "settings.connectionInvalid": "Fix settings before testing the connection.",
  "status.title": "PicGo Auto Uploader status",
  "status.automationOn": "Automation enabled",
  "status.automationOff": "Automation disabled",
  "status.picgoOnline": "PicGo online",
  "status.picgoOffline": "PicGo offline",
  "status.queueDepth": "Pending: {{count}}",
  "status.lastScan": "Last scan: {{time}}",
  "status.lastSuccess": "Last conversion: {{time}}",
  "status.never": "Never",
  "status.empty": "No jobs yet",
  "status.scan": "Scan now",
  "status.retrySafe": "Retry safe failures",
  "status.export": "Export redacted diagnostics",
  "status.clear": "Clear completed history",
  "status.clearDesc": "Actionable and safety records are retained.",
  "status.openSettings": "Open settings",
  "status.filterAll": "All",
  "status.filterSuccess": "Success",
  "status.filterFailed": "Failed",
  "status.filterUncertain": "Uncertain",
  "status.filterSkipped": "Skipped",
  "status.filterCancelled": "Cancelled",
  "status.uncertainWarn": "Retry may create a duplicate remote image",
  "status.uncertainConfirm": "Retry anyway",
  "status.rewritten": "Rewritten notes: {{count}}",
  "status.operationFailed": "The action could not be completed.",
  "status.downloadFailed": "Diagnostics could not be exported.",
  "statusbar.attention": "Needs attention: {{count}}",
  "statusbar.pending": "Uploading: {{count}} pending",
  "statusbar.disabled": "Uploader disabled",
  "statusbar.stopped": "Uploader stopped",
  "statusbar.ready": "Uploader ready",
  "statusbar.open": "Open PicGo Auto Uploader status",
  "command.open": "Open PicGo Auto Uploader status",
  "command.scan": "Scan attachment folders now",
  "command.retry": "Retry failed uploads",
  "notice.openSettingsFailed":
    "Open Obsidian settings and select PicGo Auto Uploader.",
  "job.queued": "Queued",
  "job.waiting-stable": "Waiting for a stable file",
  "job.discovering-references": "Finding references",
  "job.uploading": "Uploading",
  "job.rewriting": "Rewriting notes",
  "job.verifying": "Verifying",
  "job.trashed": "Completed",
  "job.skipped": "Skipped",
  "job.failed": "Failed",
  "job.uncertain": "Upload uncertain",
  "job.cancelled": "Cancelled",
  "stage.path": "Path",
  "stage.stability": "Stability",
  "stage.reference": "Reference",
  "stage.upload": "Upload",
  "stage.rewrite": "Rewrite",
  "stage.verify": "Verification",
  "stage.trash": "Trash",
  "stage.lifecycle": "Lifecycle",
} as const;

export type TranslationKey = keyof typeof english;

const chinese: Record<TranslationKey, string> = {
  "common.error": "发生了错误。",
  "common.apply": "应用设置",
  "common.reset": "重置非敏感设置",
  "common.openStatus": "打开状态中心",
  "common.retry": "重试",
  "common.cancel": "取消待处理任务",
  "common.loading": "正在加载…",
  "settings.title": "PicGo 自动上传",
  "settings.enabled": "自动处理",
  "settings.enabledDesc":
    "只上传被引用的图片。仅在所有引用修改通过验证后，才将本地文件移入仓库回收站。",
  "settings.origin": "PicGo 服务",
  "settings.originDesc": "PicGo HTTP 服务的基础地址。",
  "settings.secret": "PicGo 密钥",
  "settings.secretDesc":
    "可选的 Bearer 密钥。Obsidian 会将它保存在本插件本地的 data.json 中。",
  "settings.test": "测试连接",
  "settings.testSuccess": "PicGo 可以访问。",
  "settings.testFailure": "PicGo 无法访问。",
  "settings.folders": "附件文件夹",
  "settings.foldersDesc": "每行一个仓库相对路径。",
  "settings.extensions": "图片扩展名",
  "settings.extensionsDesc": "使用逗号分隔扩展名。",
  "settings.maxSize": "最大文件大小（MiB）",
  "settings.quiet": "静默时间（秒）",
  "settings.sampleInterval": "稳定性采样间隔（秒）",
  "settings.sampleCount": "稳定观察次数",
  "settings.stabilityTimeout": "稳定性超时（秒）",
  "settings.reconciliation": "定期扫描间隔（分钟）",
  "settings.requestTimeout": "请求超时（秒）",
  "settings.historyEntries": "历史记录条数",
  "settings.historyDays": "历史保留天数",
  "settings.insecureWarning":
    "此明文 HTTP 服务并非本机地址，文件路径和可选密钥可能在网络中暴露。",
  "settings.insecureAck": "我了解风险并允许对此主机使用明文 HTTP",
  "settings.validation": "请检查标出的设置。",
  "settings.saved": "设置已应用。",
  "settings.saveFailed": "设置无法保存。",
  "settings.connectionInvalid": "请先修正设置再测试连接。",
  "status.title": "PicGo 自动上传状态",
  "status.automationOn": "自动处理已启用",
  "status.automationOff": "自动处理已停用",
  "status.picgoOnline": "PicGo 在线",
  "status.picgoOffline": "PicGo 离线",
  "status.queueDepth": "待处理：{{count}}",
  "status.lastScan": "上次扫描：{{time}}",
  "status.lastSuccess": "上次转换：{{time}}",
  "status.never": "从未",
  "status.empty": "暂无任务",
  "status.scan": "立即扫描",
  "status.retrySafe": "重试安全失败项",
  "status.export": "导出已脱敏诊断",
  "status.clear": "清除已完成历史",
  "status.clearDesc": "仍会保留可操作记录和安全标记。",
  "status.openSettings": "打开设置",
  "status.filterAll": "全部",
  "status.filterSuccess": "成功",
  "status.filterFailed": "失败",
  "status.filterUncertain": "不确定",
  "status.filterSkipped": "已跳过",
  "status.filterCancelled": "已取消",
  "status.uncertainWarn": "重试可能产生重复的远程图片",
  "status.uncertainConfirm": "仍然重试",
  "status.rewritten": "已改写笔记：{{count}}",
  "status.operationFailed": "操作未能完成。",
  "status.downloadFailed": "无法导出诊断信息。",
  "statusbar.attention": "需要处理：{{count}}",
  "statusbar.pending": "正在处理：{{count}} 项",
  "statusbar.disabled": "上传器已停用",
  "statusbar.stopped": "上传器已停止",
  "statusbar.ready": "上传器已就绪",
  "statusbar.open": "打开 PicGo 自动上传状态",
  "command.open": "Open PicGo Auto Uploader status",
  "command.scan": "Scan attachment folders now",
  "command.retry": "Retry failed uploads",
  "notice.openSettingsFailed":
    "请打开 Obsidian 设置并选择 PicGo Auto Uploader。",
  "job.queued": "已排队",
  "job.waiting-stable": "等待文件稳定",
  "job.discovering-references": "正在查找引用",
  "job.uploading": "正在上传",
  "job.rewriting": "正在改写笔记",
  "job.verifying": "正在验证",
  "job.trashed": "已完成",
  "job.skipped": "已跳过",
  "job.failed": "失败",
  "job.uncertain": "上传结果不确定",
  "job.cancelled": "已取消",
  "stage.path": "路径",
  "stage.stability": "稳定性",
  "stage.reference": "引用",
  "stage.upload": "上传",
  "stage.rewrite": "改写",
  "stage.verify": "验证",
  "stage.trash": "回收站",
  "stage.lifecycle": "生命周期",
};

export const translations: Readonly<
  Record<SupportedLocale, Readonly<Record<TranslationKey, string>>>
> = {
  en: english,
  "zh-CN": chinese,
};

export function resolveLocale(locale?: string): SupportedLocale {
  const normalized = locale?.trim().toLowerCase();
  return normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized === "zh-hans"
    ? "zh-CN"
    : "en";
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function t(
  locale: SupportedLocale | string | undefined,
  key: TranslationKey,
  params: Readonly<Record<string, unknown>> = {},
): string {
  const dictionary = translations[resolveLocale(locale)];
  const template = dictionary[key] ?? english[key] ?? english["common.error"];
  return template.replace(
    /\{\{([a-zA-Z][\w-]*)\}\}/g,
    (_match, name: string) =>
      Object.hasOwn(params, name) ? escapeHtml(params[name]) : "",
  );
}
