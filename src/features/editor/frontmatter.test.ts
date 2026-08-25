import { describe, expect, it } from "vitest";
import { detectLegacyFrontmatter, splitFrontmatter, joinFrontmatter } from "./frontmatter";

describe("detectLegacyFrontmatter", () => {
  it("detects legacy frontmatter with empty line after opening", () => {
    const text = "---\n\ntitle: Hello\n---\n\nContent here";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(true);
    expect(result.normalizedText).toBeDefined();
    expect(result.normalizedText).toContain("title: Hello");
  });

  it("does not detect normal frontmatter (no empty line after opening)", () => {
    const text = "---\ntitle: Hello\n---\n\nContent here";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(false);
  });

  it("does not detect horizontal rule pairs", () => {
    const text = "---\n\n---\n\nContent";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const text = "---\r\n\r\ntitle: Hello\r\n---\r\n\r\nContent";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(true);
  });

  it("normalizes correctly and roundtrips", () => {
    const original = "---\n\ntitle: Hello\n---\n\nContent here";
    const result = detectLegacyFrontmatter(original);
    expect(result.detected).toBe(true);
    const normalized = result.normalizedText!;
    const split = splitFrontmatter(normalized);
    expect(split.frontmatter).toBeDefined();
    expect(split.body).toBe("Content here");
    expect(joinFrontmatter(split.frontmatter, split.body)).toBe(normalized);
  });

  it("does not detect frontmatter with only closing separator", () => {
    const text = "Some content\n\n---\n\nMore content";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(false);
  });

  it("detects multiple YAML keys", () => {
    const text = "---\n\ntitle: Hello\nauthor: Test\ndate: 2024-01-01\n---\n\nContent";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(true);
  });

  it("rejects when content after opening is not YAML-like", () => {
    const text = "---\n\nJust some text without colons\n---\n\nContent";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(false);
  });

  it("handles empty YAML block", () => {
    const text = "---\n\n---\n\nContent";
    const result = detectLegacyFrontmatter(text);
    expect(result.detected).toBe(false);
  });
});