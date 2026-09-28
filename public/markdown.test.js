import { describe, expect, it } from "vitest";
import {
  renderMarkdown,
  renderStreamingMarkdown,
  STREAM_REPAIR_WINDOW,
  streamRepairWindowStart,
} from "./markdown.js";

describe("renderStreamingMarkdown", () => {
  it("renders complete markdown identically to renderMarkdown", () => {
    const text = "# Title\n\nSome **bold** and `code`.\n\n```js\nconst a = 1;\n```";
    expect(renderStreamingMarkdown(text)).toBe(renderMarkdown(text));
  });

  it("closes unterminated bold mid-stream", () => {
    const html = renderStreamingMarkdown("hello **bold te");
    expect(html).toContain("<strong>bold te</strong>");
    expect(html).not.toContain("**");
  });

  it("closes unterminated inline code mid-stream", () => {
    const html = renderStreamingMarkdown("run `npm inst");
    expect(html).toContain("<code>npm inst</code>");
  });

  it("renders an unterminated code fence as a code block", () => {
    const html = renderStreamingMarkdown("```js\nconst a = 1;\nconst b");
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("```");
  });

  it("handles a fence with no newline yet", () => {
    const html = renderStreamingMarkdown("```js");
    expect(html).toContain("code-block-wrapper");
  });

  it("shows only the label for a link whose URL is still streaming", () => {
    const html = renderStreamingMarkdown("see [the docs](https://exa");
    expect(html).toContain("the docs");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("streamdown:incomplete-link");
  });

  it("returns empty string for empty input", () => {
    expect(renderStreamingMarkdown("")).toBe("");
    expect(renderStreamingMarkdown(null)).toBe("");
  });

  it("keeps the repair window to the tail of a long partial message", () => {
    // Texts up to the window take the original path…
    expect(streamRepairWindowStart("a".repeat(STREAM_REPAIR_WINDOW))).toBe(0);
    expect(streamRepairWindowStart("a".repeat(STREAM_REPAIR_WINDOW + 1))).toBeGreaterThan(0);
    // …longer ones start at the last two lines, capped.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`.padEnd(40, "x")).join("\n");
    const start = streamRepairWindowStart(lines);
    expect(lines.length - start).toBeLessThanOrEqual(STREAM_REPAIR_WINDOW);
    expect(lines.lastIndexOf("\n", start - 1)).toBeLessThan(start);
  });

  it("still closes an unterminated construct at the end of a long message", () => {
    // 12 KB of complete lines, then an open bold — the repair only runs over the
    // tail, which is where anything can still be open (inline patterns here
    // never span a line break).
    const head = Array.from({ length: 300 }, (_, i) => `line ${i} with **bold** text here`).join(
      "\n",
    );
    const html = renderStreamingMarkdown(`${head}\nand now **still writ`);
    expect(html).toContain("line 0 with <strong>bold</strong> text here");
    expect(html).toContain("<strong>still writ</strong>");
  });

  it("repairs the tail of a long unterminated code fence without touching the head", () => {
    const code = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const html = renderStreamingMarkdown(`\`\`\`js\n${code}\nconst tail`);
    expect(html).toContain("const v0 = 0;");
    expect(html).toContain("const tail");
    expect(html).toContain("code-block-wrapper");
  });
});
