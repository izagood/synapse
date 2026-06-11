import { describe, expect, it } from "vitest";
import {
  buildFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterModel,
} from "./frontmatterModel";

function mustParse(raw: string): FrontmatterModel {
  const model = parseFrontmatter(raw);
  expect(model).not.toBeNull();
  return model!;
}

describe("frontmatter model — parsing", () => {
  it("parses scalars (string/number/boolean)", () => {
    const model = mustParse(
      ["---", "title: 메모", "count: 3", "draft: true", "ratio: 1.5", "---"].join("\n"),
    );
    expect(model.fields).toEqual([
      { key: "title", value: { kind: "scalar", value: "메모" }, editable: true },
      { key: "count", value: { kind: "scalar", value: 3 }, editable: true },
      { key: "draft", value: { kind: "scalar", value: true }, editable: true },
      { key: "ratio", value: { kind: "scalar", value: 1.5 }, editable: true },
    ]);
  });

  it("parses inline string arrays (tags)", () => {
    const model = mustParse(["---", "tags: [a, b, c]", "---"].join("\n"));
    expect(model.fields[0]).toEqual({
      key: "tags",
      value: { kind: "list", value: ["a", "b", "c"] },
      editable: true,
    });
  });

  it("parses block string arrays", () => {
    const model = mustParse(["---", "tags:", "  - alpha", "  - beta", "---"].join("\n"));
    expect(model.fields[0]).toEqual({
      key: "tags",
      value: { kind: "list", value: ["alpha", "beta"] },
      editable: true,
    });
  });

  it("parses quoted strings", () => {
    const model = mustParse(["---", 'title: "a: b"', "name: 'x y'", "---"].join("\n"));
    expect(model.fields[0].value).toEqual({ kind: "scalar", value: "a: b" });
    expect(model.fields[1].value).toEqual({ kind: "scalar", value: "x y" });
  });

  it("marks complex/nested YAML as non-editable but keeps it", () => {
    const model = mustParse(
      ["---", "title: ok", "meta:", "  nested: value", "---"].join("\n"),
    );
    const meta = model.fields.find((f) => f.key === "meta");
    expect(meta?.editable).toBe(false);
    expect(model.fields.find((f) => f.key === "title")?.editable).toBe(true);
  });

  it("returns null for non-frontmatter input", () => {
    expect(parseFrontmatter(null)).toBeNull();
    expect(parseFrontmatter("# 그냥 본문")).toBeNull();
  });
});

describe("frontmatter model — roundtrip safety (NFR-3 / synapse_id)", () => {
  const cases: string[] = [
    ["---", "title: 메모", "tags: [a, b]", "---"].join("\n"),
    ["---", "synapse_id: 01HZX-ABCDEF-0123", "title: x", "---"].join("\n"),
    ["---", "tags:", "  - alpha", "  - beta", "---"].join("\n"),
    ["---", "title: ok", "meta:", "  nested: value", "extra: 7", "---"].join("\n"),
    ["---", "# 주석", "title: x", "", "draft: false", "---"].join("\n"),
    ["---", 'q: "a: b"', "n: 3", "---"].join("\n"),
    "---\r\ntitle: x\r\nsynapse_id: ZZZ\r\n---",
  ];

  it("parse → serialize (no edits) reproduces the original verbatim", () => {
    for (const raw of cases) {
      const model = mustParse(raw);
      expect(serializeFrontmatter(model)).toBe(raw);
    }
  });

  it("preserves synapse_id untouched when another field is edited", () => {
    const raw = ["---", "synapse_id: 01HZX-CRDT-KEY", "title: 옛 제목", "---"].join("\n");
    const model = mustParse(raw);
    const out = serializeFrontmatter(model, {
      updated: { title: { kind: "scalar", value: "새 제목" } },
    });
    expect(out).toContain("synapse_id: 01HZX-CRDT-KEY");
    expect(out).toContain("title: 새 제목");
    // 재파싱해도 synapse_id 보존
    expect(mustParse(out).fields.find((f) => f.key === "synapse_id")?.value).toEqual({
      kind: "scalar",
      value: "01HZX-CRDT-KEY",
    });
  });

  it("preserves non-editable complex entries verbatim across edits", () => {
    const raw = ["---", "meta:", "  nested: value", "title: a", "---"].join("\n");
    const model = mustParse(raw);
    const out = serializeFrontmatter(model, {
      updated: { title: { kind: "scalar", value: "b" } },
    });
    expect(out).toBe(["---", "meta:", "  nested: value", "title: b", "---"].join("\n"));
  });

  it("edited value re-parses to the new value", () => {
    const raw = ["---", "tags: [a]", "---"].join("\n");
    const model = mustParse(raw);
    const out = serializeFrontmatter(model, {
      updated: { tags: { kind: "list", value: ["a", "b", "c"] } },
    });
    expect(out).toBe(["---", "tags: [a, b, c]", "---"].join("\n"));
    expect(mustParse(out).fields[0].value).toEqual({ kind: "list", value: ["a", "b", "c"] });
  });

  it("removes a field", () => {
    const raw = ["---", "a: 1", "b: 2", "---"].join("\n");
    const out = serializeFrontmatter(mustParse(raw), { removed: new Set(["a"]) });
    expect(out).toBe(["---", "b: 2", "---"].join("\n"));
  });

  it("adds a field at the end", () => {
    const raw = ["---", "a: 1", "---"].join("\n");
    const out = serializeFrontmatter(mustParse(raw), {
      added: [{ key: "tags", value: { kind: "list", value: ["x"] } }],
    });
    expect(out).toBe(["---", "a: 1", "tags: [x]", "---"].join("\n"));
  });
});

describe("frontmatter model — serialization safety", () => {
  it("quotes strings that would otherwise be misread", () => {
    const out = buildFrontmatter([
      { key: "title", value: { kind: "scalar", value: "a: b" } },
      { key: "tricky", value: { kind: "scalar", value: "true" } },
      { key: "num", value: { kind: "scalar", value: "42" } },
      { key: "empty", value: { kind: "scalar", value: "" } },
    ]);
    expect(out).toBe(
      ["---", 'title: "a: b"', 'tricky: "true"', 'num: "42"', 'empty: ""', "---"].join("\n"),
    );
    // 재파싱하면 원래 문자열 값으로 복원
    const model = mustParse(out);
    expect(model.fields.map((f) => f.value)).toEqual([
      { kind: "scalar", value: "a: b" },
      { kind: "scalar", value: "true" },
      { kind: "scalar", value: "42" },
      { kind: "scalar", value: "" },
    ]);
  });

  it("escapes quotes and backslashes inside quoted strings", () => {
    const out = buildFrontmatter([
      { key: "p", value: { kind: "scalar", value: 'he said "hi"' } },
    ]);
    expect(out).toContain('p: "he said \\"hi\\""');
    expect(mustParse(out).fields[0].value).toEqual({ kind: "scalar", value: 'he said "hi"' });
  });

  it("round-trips a full edit cycle stably (idempotent)", () => {
    const raw = ["---", "synapse_id: KEEP", "title: t", "tags: [a, b]", "---"].join("\n");
    const model = mustParse(raw);
    const once = serializeFrontmatter(model, {
      updated: {
        title: { kind: "scalar", value: "t2" },
        tags: { kind: "list", value: ["a", "b", "c"] },
      },
    });
    const twice = serializeFrontmatter(mustParse(once));
    expect(twice).toBe(once);
    expect(once).toContain("synapse_id: KEEP");
  });
});
