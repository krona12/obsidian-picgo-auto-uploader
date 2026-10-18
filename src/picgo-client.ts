import * as http from "node:http";
import * as https from "node:https";
import { posix, win32 } from "node:path";
import { validateSettings } from "./defaults";
import type { JobFailure, PluginSettings, Result } from "./domain";

export interface PicGoRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface PicGoResponse {
  statusCode: number;
  body: string;
}

export interface PicGoTransportFailure {
  kind:
    | "timeout"
    | "disconnected"
    | "refused"
    | "aborted"
    | "response-too-large"
    | "invalid-request";
  dispatched: boolean;
}

export type PicGoTransportResult = Result<PicGoResponse, PicGoTransportFailure>;

export interface PicGoTransport {
  request(
    request: PicGoRequest,
    signal?: AbortSignal,
  ): Promise<PicGoTransportResult>;
}

export interface PicGoFailure extends JobFailure {
  state: "failed" | "uncertain" | "cancelled" | "skipped";
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

/** Node transport deliberately returns no native errors, headers, or request data. */
export class NodePicGoTransport implements PicGoTransport {
  request(
    input: PicGoRequest,
    signal?: AbortSignal,
  ): Promise<PicGoTransportResult> {
    if (signal?.aborted)
      return Promise.resolve({
        ok: false,
        error: { kind: "aborted", dispatched: false },
      });
    let url: URL;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      url = new URL(input.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1
      ) {
        return Promise.resolve({
          ok: false,
          error: { kind: "invalid-request", dispatched: false },
        });
      }
    } catch {
      return Promise.resolve({
        ok: false,
        error: { kind: "invalid-request", dispatched: false },
      });
    }

    return new Promise((resolve) => {
      let request: http.ClientRequest | undefined;
      let dispatched = false;
      let connected = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: PicGoTransportResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const fail = (kind: PicGoTransportFailure["kind"]) => {
        finish({ ok: false, error: { kind, dispatched } });
        request?.destroy();
      };
      const abort = () => fail("aborted");
      try {
        // Node http(s) exposes 3xx responses directly and never follows Location.
        request = (url.protocol === "https:" ? https : http).request(
          url,
          {
            method: input.method,
            headers: input.headers,
          },
          (response) => {
            if (
              response.statusCode &&
              (response.statusCode < 200 || response.statusCode >= 300)
            ) {
              // HTTP rejection is already explicit; a stalled body cannot make it uncertain.
              finish({
                ok: true,
                value: { statusCode: response.statusCode, body: "" },
              });
              response.destroy();
              request?.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE_BYTES) {
                fail("response-too-large");
                response.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              if (!response.complete) return fail("disconnected");
              finish({
                ok: true,
                value: {
                  statusCode: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                },
              });
            });
            response.on("aborted", () => fail("disconnected"));
            response.on("error", () => fail("disconnected"));
            response.on("close", () => {
              if (!response.complete) fail("disconnected");
            });
          },
        );
        request.on("socket", (socket) => {
          if (!socket.connecting) connected = true;
          socket.once("connect", () => {
            connected = true;
          });
        });
        request.on("error", (error: NodeJS.ErrnoException) => {
          fail(
            error.code === "ECONNREFUSED" && !connected
              ? "refused"
              : "disconnected",
          );
        });
        request.on("close", () => {
          if (!settled) fail("disconnected");
        });
        signal?.addEventListener("abort", abort, { once: true });
        // Total deadline, rather than an idle timeout that a streaming peer can extend.
        timer = setTimeout(() => fail("timeout"), timeoutMs);
        if (signal?.aborted) return abort();
        request.end(input.body);
        dispatched = true;
      } catch {
        fail("invalid-request");
      }
    });
  }
}

function failure(
  code: string,
  message: string,
  state: PicGoFailure["state"] = "failed",
): Result<never, PicGoFailure> {
  return {
    ok: false,
    error: {
      code,
      message,
      state,
      stage: "upload",
      retry:
        state === "uncertain"
          ? "uncertain"
          : state === "failed"
            ? "safe"
            : "non-retryable",
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseResponse(
  response: PicGoResponse,
): Result<Record<string, unknown>, PicGoFailure> {
  if (response.statusCode < 200 || response.statusCode >= 300)
    return failure(
      "http-failure",
      "PicGo returned an unsuccessful HTTP status.",
    );
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return failure("invalid-response", "PicGo returned invalid JSON.");
  }
  const data = object(body);
  if (!data || data.success !== true || data.error)
    return failure("picgo-failure", "PicGo did not confirm success.");
  return { ok: true, value: data };
}

function validRemoteUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    !/^https?:\/\//i.test(value) ||
    /[\\\s]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function validSourcePath(path: string): boolean {
  // win32.isAbsolute also accepts drive-relative roots; require a drive or UNC share.
  const windows =
    win32.isAbsolute(path) &&
    (/^[A-Za-z]:[\\/]/.test(path) ||
      /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(path));
  // eslint-disable-next-line no-control-regex -- Paths cannot contain NUL or header/control characters.
  const controls = /[\u0000-\u001f\u007f]/;
  return (
    Boolean(path) && !controls.test(path) && (windows || posix.isAbsolute(path))
  );
}

/** One upload attempt only; the caller owns retry and uncertainty policy. */
export class PicGoClient {
  private readonly settings: PluginSettings;
  constructor(
    settings: PluginSettings,
    private readonly transport: PicGoTransport = new NodePicGoTransport(),
  ) {
    this.settings = { ...settings };
  }

  heartbeat(signal?: AbortSignal): Promise<Result<void, PicGoFailure>> {
    return this.execute("heartbeat", undefined, signal).then((result) =>
      result.ok ? { ok: true, value: undefined } : result,
    );
  }

  async uploadOne(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<Result<string, PicGoFailure>> {
    if (!validSourcePath(absolutePath))
      return failure(
        "invalid-path",
        "An absolute source path is required.",
        "skipped",
      );
    const response = await this.execute("upload", absolutePath, signal);
    if (!response.ok) return response;
    const data = response.value;
    if (
      !Array.isArray(data.result) ||
      data.result.length !== 1 ||
      !validRemoteUrl(data.result[0])
    )
      return failure(
        "invalid-result",
        "PicGo did not return exactly one valid image URL.",
      );
    const url = data.result[0];
    if ("items" in data) {
      if (!Array.isArray(data.items) || data.items.length !== 1)
        return failure(
          "invalid-items",
          "PicGo returned inconsistent item metadata.",
        );
      const item = object(data.items[0]);
      if (
        !item ||
        item.imgUrl !== url ||
        ("origin" in item && item.origin !== absolutePath) ||
        ("success" in item && item.success !== true) ||
        item.error
      )
        return failure(
          "invalid-items",
          "PicGo returned inconsistent item metadata.",
        );
    }
    return { ok: true, value: url };
  }

  private async execute(
    endpoint: "heartbeat" | "upload",
    source: string | undefined,
    signal?: AbortSignal,
  ): Promise<Result<Record<string, unknown>, PicGoFailure>> {
    if (signal?.aborted)
      return failure(
        "aborted",
        "PicGo request was cancelled before dispatch.",
        "cancelled",
      );
    const validated = validateSettings(this.settings);
    if (!validated.ok)
      return failure(
        "invalid-settings",
        "PicGo settings are invalid.",
        "skipped",
      );
    const settings = validated.value;
    const headers: Record<string, string> = {};
    if (settings.picgoSecret)
      headers.Authorization = `Bearer ${settings.picgoSecret}`;
    if (endpoint === "upload") headers["Content-Type"] = "application/json";
    let result: PicGoTransportResult;
    try {
      result = await this.transport.request(
        {
          url: `${settings.picgoOrigin}/${endpoint}`,
          method: endpoint === "upload" ? "POST" : "GET",
          headers,
          timeoutMs: settings.requestTimeoutMs,
          ...(endpoint === "upload"
            ? { body: JSON.stringify({ list: [source] }) }
            : {}),
        },
        signal,
      );
    } catch {
      // A transport that throws cannot prove whether the upload reached PicGo.
      return failure(
        "transport-failure",
        "PicGo request ended without a confirmed result.",
        "uncertain",
      );
    }
    if (result.ok) return parseResponse(result.value);
    const error = result.error;
    if (error.kind === "aborted" && !error.dispatched)
      return failure(
        "aborted",
        "PicGo request was cancelled before dispatch.",
        "cancelled",
      );
    if (error.kind === "invalid-request")
      return failure(
        "invalid-request",
        "PicGo request could not be constructed.",
        "skipped",
      );
    if (error.kind === "response-too-large")
      return failure(
        error.kind,
        "PicGo response exceeded the metadata size limit.",
      );
    if (error.kind === "refused")
      return failure("connection-refused", "PicGo refused the connection.");
    return failure(
      error.kind,
      "PicGo request ended without a confirmed result.",
      error.dispatched ? "uncertain" : "failed",
    );
  }
}
