import { describe, expect, it } from "vitest";
import {
  applyVerifiedEdits,
  buildRewriteEdit,
  type EmbedReference,
  type RewriteEdit,
} from "../src/reference-rewriter";

const url = "https://cdn.example/image(1).png?x=1&y=2";
function reference(source: string, start = 0): EmbedReference {
  return {
    notePath: "notes/note.md",
    targetPath: "attachments/a.png",
    start,
    end: start + source.length,
    expectedSource: source,
  };
}

describe("verified embed edits", () => {
  // Break: discarding display values, escaping existing Markdown twice, or replacing titles.
  it.each([
    [
      "![[attachments/a.png]]",
      "![](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![[attachments/a.png|A photo]]",
      "![A photo](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![[attachments/a.png|A *photo*]]",
      "![A \\*photo\\*](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![[attachments/a.png|300]]",
      "![|300](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![[attachments/a.png|300x200]]",
      "![|300x200](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![[attachments/a.png|A [photo]]]",
      "![A \\[photo\\]](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![Alt](attachments/a.png)",
      "![Alt](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      "![A \\[photo\\]](<attachments/a photo.png>)",
      "![A \\[photo\\]](<https://cdn.example/image(1).png?x=1&y=2>)",
    ],
    [
      '![Alt](attachments/a\\(1\\).png "A \\"title\\"")',
      '![Alt](<https://cdn.example/image(1).png?x=1&y=2> "A \\"title\\"")',
    ],
    [
      "![Alt](<attachments/a photo.png>  'A title')",
      "![Alt](<https://cdn.example/image(1).png?x=1&y=2>  'A title')",
    ],
    [
      "![](attachments/a(1).png (A title))",
      "![](<https://cdn.example/image(1).png?x=1&y=2> (A title))",
    ],
  ])("preserves the visible payload of %s", (source, replacement) => {
    expect(buildRewriteEdit(reference(source, 7), url)).toEqual({
      ok: true,
      value: { ...reference(source, 7), replacement },
    });
  });

  it.each([
    "![[a.png|alt|300]]",
    "![[a.png#section]]",
    "![Alt][image]",
    "<img src='a.png'>",
    "![Alt](a photo.png)",
    '![Alt](a.png "unterminated)',
    "![Alt](a.png) trailing",
    "![[a.png",
    "![Alt](a.png\n)",
  ])("blocks unsupported or malformed syntax: %s", (source) => {
    expect(buildRewriteEdit(reference(source), url)).toMatchObject({
      ok: false,
      error: { code: "unsupported-syntax" },
    });
  });

  it.each([
    "javascript:alert(1)",
    "https://user:pass@cdn.example/a.png",
    "https://cdn.example/a>bad",
    "https://cdn.example/a b",
    "https://cdn.example/a\\b",
    "https://cdn.example/a\u0000b",
  ])("rejects unsafe destination %s", (remote) => {
    expect(buildRewriteEdit(reference("![[a.png]]"), remote)).toMatchObject({
      ok: false,
      error: { code: "invalid-remote-url" },
    });
  });

  it("applies unsorted edits from right to left and preserves every unrelated byte", () => {
    const content = "前 ![[a.png]] + ![B](b.png)\r\nend";
    const edits: RewriteEdit[] = [
      {
        ...reference("![[a.png]]", 2),
        replacement: "![|300](<https://cdn/a>)",
      },
      { ...reference("![B](b.png)", 15), replacement: "![B](<https://cdn/b>)" },
    ];
    expect(applyVerifiedEdits(content, edits)).toEqual({
      ok: true,
      value: "前 ![|300](<https://cdn/a>) + ![B](<https://cdn/b>)\r\nend",
    });
    expect(edits[0]?.start).toBe(2);
  });

  it("rejects the entire note before changing any text when a slice is stale", () => {
    expect(
      applyVerifiedEdits("![[b.png]]", [
        { ...reference("![[a.png]]"), replacement: "remote" },
      ]),
    ).toMatchObject({ ok: false, error: { code: "stale-offsets" } });
  });

  it.each([-1, 99, 1.5, Number.NaN])(
    "rejects invalid start offset %s",
    (start) => {
      expect(
        applyVerifiedEdits("![[a.png]]", [
          { ...reference("![[a.png]]", start), replacement: "remote" },
        ]),
      ).toMatchObject({ ok: false, error: { code: "stale-offsets" } });
    },
  );

  it("rejects overlapping or duplicate edits and edits belonging to different notes", () => {
    const edit = { ...reference("![[a.png]]"), replacement: "remote" };
    expect(applyVerifiedEdits("![[a.png]]", [edit, edit])).toMatchObject({
      ok: false,
      error: { code: "overlapping-edits" },
    });
    expect(
      applyVerifiedEdits("![[a.png]]![[b.png]]", [
        edit,
        {
          ...reference("![[b.png]]", 10),
          notePath: "other.md",
          replacement: "remote",
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: "mixed-notes" } });
  });
});
