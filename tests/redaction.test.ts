import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "../src/defaults";
import { createDiagnosticExport, redactText } from "../src/redaction";

const secret = ["diagnostic", "sentinel", "credential"].join("-");
const absolutePath = ["Z:", "Sensitive Vault", "attachments", "photo.png"].join(
  "\\",
);

describe("diagnostic redaction", () => {
  it("removes supplied secrets and exact path variants while preserving vault context", () => {
    const input = `${secret} ${absolutePath} ${absolutePath.replaceAll("\\", "/")} attachments/photo.png`;
    const redacted = redactText(input, [secret, ""], [absolutePath]);
    expect(
      redacted.includes(secret) || redacted.includes("Sensitive Vault"),
    ).toBe(false);
    expect(redacted).toContain("attachments/photo.png");
  });

  it("removes unknown bearer and basic authorization values", () => {
    const output = redactText(
      'Authorization: Bearer opaque-token\n{"authorization":"Basic opaque-basic"}\nauthorization=Bearer another-token',
      [],
      [],
    );
    expect(
      ["opaque-token", "opaque-basic", "another-token"].some((part) =>
        output.includes(part),
      ),
    ).toBe(false);
    expect(output).toContain("[REDACTED]");
  });

  it("removes authorization values with arbitrary schemes or no scheme", () => {
    const output = redactText(
      'Authorization: Custom opaque-custom\n{"authorization":"opaque-raw"}\nauthorization=opaque-assignment',
      [],
      [],
    );
    expect(
      ["opaque-custom", "opaque-raw", "opaque-assignment"].some((part) =>
        output.includes(part),
      ),
    ).toBe(false);
  });

  it("can redact a secret containing an unpaired Unicode surrogate", () => {
    const malformed = String.fromCharCode(0xd800);
    expect(redactText(`before ${malformed} after`, [malformed], [])).toBe(
      "before [REDACTED] after",
    );
  });

  it("removes unlisted drive, forward-slash and UNC absolute paths", () => {
    const drive = ["Q:", "Unlisted Private", "photo.png"].join("\\");
    const unc = ["", "", "private-host", "share", "photo.png"].join("\\");
    const text = redactText(
      `failed: "${drive}"; '${drive.replaceAll("\\", "/")}' ${unc}\nvault=attachments/photo.png`,
      [],
      [],
    );
    expect(
      ["Unlisted Private", "private-host", "Q:"].some((part) =>
        text.includes(part),
      ),
    ).toBe(false);
    expect(text).toContain("attachments/photo.png");
  });

  it("removes UNC share roots and slash-normalized UNC paths", () => {
    const root = ["", "", "private-host", "share"].join("\\");
    const output = redactText(
      `"${root}" "${root.replaceAll("\\", "/")}/photo.png"`,
      [],
      [],
    );
    expect(output.includes("private-host")).toBe(false);
    expect(redactText("https://images.example.com/photo.png", [], [])).toBe(
      "https://images.example.com/photo.png",
    );
  });

  it("exports serializable structure without secret fields or nested credentials", () => {
    const snapshot = {
      settings: sanitizeSettings({ picgoSecret: secret }),
      jobs: [
        {
          vaultPath: "attachments/photo.png",
          state: "failed",
          message: `${absolutePath} ${secret}`,
        },
      ],
      logs: [{ message: `Authorization: Bearer ${secret}` }],
      nested: {
        authorization: "Bearer opaque-token",
        secret: "nested-value",
        picgoSecret: "other-value",
      },
      absolutePaths: [absolutePath],
    };
    const exported = createDiagnosticExport(snapshot);
    const serialized = JSON.stringify(exported);
    expect(
      [
        secret,
        "Sensitive Vault",
        "opaque-token",
        "nested-value",
        "other-value",
        "picgoSecret",
      ].some((value) => serialized.includes(value)),
    ).toBe(false);
    expect(exported).toMatchObject({
      jobs: [{ vaultPath: "attachments/photo.png", state: "failed" }],
      settings: { picgoOrigin: "http://127.0.0.1:36677" },
    });
    expect(snapshot.settings.picgoSecret === secret).toBe(true);
  });

  it("redacts escaped paths and secrets in object keys in its final pass", () => {
    const exported = createDiagnosticExport({
      settings: { picgoSecret: secret },
      [secret]: {
        [absolutePath]: JSON.stringify({
          source: absolutePath,
          detail: secret,
        }),
      },
    });
    const output = JSON.stringify(exported);
    expect(output.includes(secret) || output.includes("Sensitive Vault")).toBe(
      false,
    );
  });
});
