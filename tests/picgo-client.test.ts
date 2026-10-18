import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeSettings } from "../src/defaults";
import {
  NodePicGoTransport,
  PicGoClient,
  type PicGoRequest,
  type PicGoTransport,
  type PicGoTransportResult,
} from "../src/picgo-client";

// Construct sentinels so failure output never includes a real user's path or token.
const sourcePath = ["Z:", "private-vault", "attachments", "image.png"].join(
  "\\",
);
const secret = ["boundary", "sentinel", "credential"].join("-");
const remoteUrl = "https://images.example.com/image.png";

class MemoryTransport implements PicGoTransport {
  readonly requests: PicGoRequest[] = [];
  constructor(private readonly response: PicGoTransportResult) {}
  request(request: PicGoRequest): Promise<PicGoTransportResult> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }
}

function reply(body: unknown, statusCode = 200): PicGoTransportResult {
  return { ok: true, value: { statusCode, body: JSON.stringify(body) } };
}

function client(transport: PicGoTransport, overrides = {}) {
  return new PicGoClient(sanitizeSettings(overrides), transport);
}

describe("PicGo protocol", () => {
  it("probes only the heartbeat endpoint with the configured timeout", async () => {
    const transport = new MemoryTransport(
      reply({ success: true, message: "alive" }),
    );
    expect(await client(transport).heartbeat()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(transport.requests).toEqual([
      {
        url: "http://127.0.0.1:36677/heartbeat",
        method: "GET",
        headers: {},
        timeoutMs: 30000,
      },
    ]);
  });

  it("sends exactly one absolute path and authenticates only in the bearer header", async () => {
    const transport = new MemoryTransport(
      reply({
        success: true,
        result: [remoteUrl],
        items: [{ origin: sourcePath, imgUrl: remoteUrl }],
      }),
    );
    expect(
      await client(transport, {
        picgoSecret: secret,
        requestTimeoutMs: 731,
      }).uploadOne(sourcePath),
    ).toEqual({ ok: true, value: remoteUrl });
    const request = transport.requests[0]!;
    expect(request.url).toBe("http://127.0.0.1:36677/upload");
    expect(request.method).toBe("POST");
    expect(request.timeoutMs).toBe(731);
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.headers.Authorization === `Bearer ${secret}`).toBe(true);
    expect(request.body === JSON.stringify({ list: [sourcePath] })).toBe(true);
    expect(Object.keys(request.headers).sort()).toEqual([
      "Authorization",
      "Content-Type",
    ]);
  });

  it("omits authentication when the configured secret is empty", async () => {
    const transport = new MemoryTransport(
      reply({ success: true, result: [remoteUrl] }),
    );
    await client(transport).uploadOne(sourcePath);
    expect(transport.requests[0]!.headers).not.toHaveProperty("Authorization");
  });

  it.each([
    {
      name: "non-2xx",
      response: reply({ success: true, result: [remoteUrl] }, 500),
    },
    {
      name: "redirect",
      response: reply({ success: true, result: [remoteUrl] }, 302),
    },
    {
      name: "invalid JSON",
      response: {
        ok: true as const,
        value: { statusCode: 200, body: "not JSON" },
      },
    },
    { name: "null", response: reply(null) },
    { name: "array", response: reply([]) },
    {
      name: "false success",
      response: reply({ success: false, result: [remoteUrl] }),
    },
    {
      name: "truthy success",
      response: reply({ success: "true", result: [remoteUrl] }),
    },
    { name: "missing result", response: reply({ success: true }) },
    {
      name: "string result",
      response: reply({ success: true, result: remoteUrl }),
    },
    { name: "empty result", response: reply({ success: true, result: [] }) },
    {
      name: "multiple results",
      response: reply({ success: true, result: [remoteUrl, remoteUrl] }),
    },
    { name: "empty URL", response: reply({ success: true, result: [""] }) },
    {
      name: "non-string URL",
      response: reply({ success: true, result: [42] }),
    },
    {
      name: "file URL",
      response: reply({ success: true, result: ["file:///image.png"] }),
    },
    {
      name: "script URL",
      response: reply({ success: true, result: ["javascript:alert(1)"] }),
    },
    {
      name: "relative URL",
      response: reply({ success: true, result: ["/image.png"] }),
    },
    {
      name: "HTTP URL missing authority separators",
      response: reply({
        success: true,
        result: ["https:images.example.com/image.png"],
      }),
    },
    {
      name: "HTTP URL using backslashes",
      response: reply({
        success: true,
        result: ["https:\\\\images.example.com\\image.png"],
      }),
    },
    {
      name: "contradictory error",
      response: reply({ success: true, result: [remoteUrl], error: "failed" }),
    },
    {
      name: "different item URL",
      response: reply({
        success: true,
        result: [remoteUrl],
        items: [
          {
            origin: sourcePath,
            imgUrl: "https://images.example.com/other.png",
          },
        ],
      }),
    },
    {
      name: "different item origin",
      response: reply({
        success: true,
        result: [remoteUrl],
        items: [{ origin: "other.png", imgUrl: remoteUrl }],
      }),
    },
    {
      name: "failed item",
      response: reply({
        success: true,
        result: [remoteUrl],
        items: [{ origin: sourcePath, imgUrl: remoteUrl, success: false }],
      }),
    },
    {
      name: "item error",
      response: reply({
        success: true,
        result: [remoteUrl],
        items: [{ origin: sourcePath, imgUrl: remoteUrl, error: "failed" }],
      }),
    },
    {
      name: "empty items",
      response: reply({ success: true, result: [remoteUrl], items: [] }),
    },
    {
      name: "non-array items",
      response: reply({ success: true, result: [remoteUrl], items: {} }),
    },
    {
      name: "duplicate items",
      response: reply({
        success: true,
        result: [remoteUrl],
        items: [{ imgUrl: remoteUrl }, { imgUrl: remoteUrl }],
      }),
    },
  ])(
    "rejects $name as a safe explicit failure without retrying",
    async ({ response }) => {
      const transport = new MemoryTransport(response);
      const result = await client(transport).uploadOne(sourcePath);
      expect(result).toMatchObject({
        ok: false,
        error: { state: "failed", retry: "safe", stage: "upload" },
      });
      expect(transport.requests).toHaveLength(1);
    },
  );

  it("accepts an HTTP URL and an item without optional origin", async () => {
    const url = "http://images.example.com/image.png";
    expect(
      await client(
        new MemoryTransport(
          reply({
            success: true,
            result: [url],
            error: null,
            items: [{ imgUrl: url }],
          }),
        ),
      ).uploadOne(sourcePath),
    ).toEqual({ ok: true, value: url });
  });

  it.each(["timeout", "disconnected", "aborted"] as const)(
    "keeps %s after dispatch uncertain",
    async (kind) => {
      const transport = new MemoryTransport({
        ok: false,
        error: { kind, dispatched: true },
      });
      expect(await client(transport).uploadOne(sourcePath)).toMatchObject({
        ok: false,
        error: { state: "uncertain", retry: "uncertain" },
      });
      expect(transport.requests).toHaveLength(1);
    },
  );

  it("classifies connection refusal as a safe failure", async () => {
    expect(
      await client(
        new MemoryTransport({
          ok: false,
          error: { kind: "refused", dispatched: true },
        }),
      ).uploadOne(sourcePath),
    ).toMatchObject({ ok: false, error: { state: "failed", retry: "safe" } });
  });

  it("does not dispatch an already aborted upload", async () => {
    const transport = new MemoryTransport(
      reply({ success: true, result: [remoteUrl] }),
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      await client(transport).uploadOne(sourcePath, controller.signal),
    ).toMatchObject({
      ok: false,
      error: { state: "cancelled", retry: "non-retryable" },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects a relative source before dispatch", async () => {
    const transport = new MemoryTransport(
      reply({ success: true, result: [remoteUrl] }),
    );
    expect(
      await client(transport).uploadOne("attachments/image.png"),
    ).toMatchObject({
      ok: false,
      error: { state: "skipped", retry: "non-retryable" },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it.each([
    "http://user:password@localhost",
    "http://localhost/upload/..",
    "http://localhost?key=value",
    "http://localhost#fragment",
    "file:///tmp",
    "http://example.com",
  ])(
    "rejects an unvalidated origin before transport access",
    async (picgoOrigin) => {
      const transport = new MemoryTransport(
        reply({ success: true, result: [remoteUrl] }),
      );
      const settings = { ...sanitizeSettings(undefined), picgoOrigin };
      expect(
        await new PicGoClient(settings, transport).uploadOne(sourcePath),
      ).toMatchObject({
        ok: false,
        error: { state: "skipped", retry: "non-retryable" },
      });
      expect(transport.requests).toHaveLength(0);
    },
  );

  it("does not expose arbitrary response text or thrown transport details", async () => {
    const payload = `${secret} ${sourcePath} Authorization: Bearer hidden`;
    const explicit = await client(
      new MemoryTransport(
        reply({ success: false, message: payload, error: payload }),
      ),
    ).uploadOne(sourcePath);
    const throwing: PicGoTransport = {
      request: () => Promise.reject(new Error(payload)),
    };
    const unexpected = await client(throwing, {
      picgoSecret: secret,
    }).uploadOne(sourcePath);
    for (const result of [explicit, unexpected]) {
      const text = JSON.stringify(result);
      expect(
        [secret, sourcePath, "hidden"].some((value) => text.includes(value)),
      ).toBe(false);
    }
    expect(unexpected).toMatchObject({
      ok: false,
      error: { state: "uncertain", retry: "uncertain" },
    });
  });

  it("requires a valid heartbeat response without treating it as an upload", async () => {
    expect(
      await client(new MemoryTransport(reply({ success: false }))).heartbeat(),
    ).toMatchObject({ ok: false });
    expect(
      await client(
        new MemoryTransport(reply({ success: true }, 503)),
      ).heartbeat(),
    ).toMatchObject({ ok: false });
  });
});

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("Node PicGo transport", () => {
  it("delivers the exact request over HTTP and returns the complete response", async () => {
    let received = false;
    const origin = await localServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        received =
          request.method === "POST" &&
          request.url === "/upload" &&
          request.headers.authorization === `Bearer ${secret}` &&
          request.headers["content-type"] === "application/json" &&
          body === JSON.stringify({ list: [sourcePath] });
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, result: [remoteUrl] }));
      });
    });
    const result = await new PicGoClient(
      sanitizeSettings({ picgoOrigin: origin, picgoSecret: secret }),
    ).uploadOne(sourcePath);
    expect(result).toEqual({ ok: true, value: remoteUrl });
    expect(received).toBe(true);
  });

  it("does not follow redirects or forward authorization to the destination", async () => {
    let destinationCalls = 0;
    const destination = await localServer((_request, response) => {
      destinationCalls++;
      response.end("{}");
    });
    const origin = await localServer((_request, response) => {
      response.writeHead(302, { Location: `${destination}/upload` });
      response.end();
    });
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin, picgoSecret: secret }),
      ).uploadOne(sourcePath),
    ).toMatchObject({ ok: false, error: { state: "failed", retry: "safe" } });
    expect(destinationCalls).toBe(0);
  });

  it("times out after dispatch even when the server keeps sending data", async () => {
    const origin = await localServer((_request, response) => {
      response.writeHead(200);
      const interval = setInterval(() => response.write(" "), 5);
      response.on("close", () => clearInterval(interval));
    });
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin, requestTimeoutMs: 60 }),
      ).uploadOne(sourcePath),
    ).toMatchObject({
      ok: false,
      error: { state: "uncertain", retry: "uncertain" },
    });
  });

  it("classifies a prematurely closed response as uncertain", async () => {
    const origin = await localServer((_request, response) => {
      response.writeHead(200, { "Content-Length": "1000" });
      response.write("{");
      setImmediate(() => response.destroy());
    });
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin }),
      ).uploadOne(sourcePath),
    ).toMatchObject({
      ok: false,
      error: { state: "uncertain", retry: "uncertain" },
    });
  });

  it("keeps an explicit HTTP rejection safe even if its body never finishes", async () => {
    const origin = await localServer((_request, response) => {
      response.writeHead(503);
      response.write("rejected");
    });
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin, requestTimeoutMs: 60 }),
      ).uploadOne(sourcePath),
    ).toMatchObject({
      ok: false,
      error: { state: "failed", retry: "safe", code: "http-failure" },
    });
  });

  it("classifies an aborted in-flight request as uncertain", async () => {
    const controller = new AbortController();
    const origin = await localServer(() => controller.abort());
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin }),
      ).uploadOne(sourcePath, controller.signal),
    ).toMatchObject({
      ok: false,
      error: { state: "uncertain", retry: "uncertain" },
    });
  });

  it("rejects a response exceeding the metadata byte limit", async () => {
    const origin = await localServer((_request, response) =>
      response.end(" ".repeat(1024 * 1024 + 1)),
    );
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin }),
      ).uploadOne(sourcePath),
    ).toMatchObject({
      ok: false,
      error: { state: "failed", retry: "safe", code: "response-too-large" },
    });
  });

  it("returns a safe refusal after the local listener has closed", async () => {
    const origin = await localServer((_request, response) => response.end());
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(
      await new PicGoClient(
        sanitizeSettings({ picgoOrigin: origin }),
      ).uploadOne(sourcePath),
    ).toMatchObject({ ok: false, error: { state: "failed", retry: "safe" } });
  });

  it("honors abort before dispatch in the transport itself", async () => {
    let calls = 0;
    const origin = await localServer((_request, response) => {
      calls++;
      response.end();
    });
    const controller = new AbortController();
    controller.abort();
    const result = await new NodePicGoTransport().request(
      { url: `${origin}/heartbeat`, method: "GET", headers: {} },
      controller.signal,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "aborted", dispatched: false },
    });
    expect(calls).toBe(0);
  });
});
