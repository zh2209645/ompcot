import { describe, expect, it, vi } from "vitest";
import { buildRenderDump } from "./render-export.js";

/** A document double with the pieces the exporter looks at. */
function makeDoc({ html = "", href = "http://127.0.0.1:47822/" } = {}) {
  document.documentElement.innerHTML = `<head>
    <link rel="stylesheet" href="style-theme.css">
    <link rel="stylesheet" href="style.css">
    <script>window.__booted = true;</script>
  </head>
  <body>
    <div class="main">
      <div class="messages-wrap"><div class="messages" id="messages">${html}</div></div>
      <img id="logo" src="icons/logo-dark.svg" alt="">
    </div>
    <script src="app.js"></script>
  </body>`;
  Object.defineProperty(document, "baseURI", { value: href, configurable: true });
  return document;
}

function fetchStub(routes) {
  return vi.fn(async (url) => {
    const entry = routes[url];
    if (entry === undefined) return { ok: false, status: 404, text: async () => "" };
    if (typeof entry === "string") {
      return { ok: true, status: 200, text: async () => entry, headers: { get: () => "text/css" } };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => entry,
      headers: { get: () => "image/svg+xml" },
    };
  });
}

describe("buildRenderDump", () => {
  it("keeps the rendered markup and strips every script", async () => {
    makeDoc({ html: '<div class="message user"><div class="message-content">hello</div></div>' });
    const { html, stats } = await buildRenderDump(document, { fetchImpl: null });

    expect(html).toContain('class="message user"');
    expect(html).toContain("hello");
    expect(html).not.toContain("<script"); // the boot script and the page's own
    expect(stats.scripts).toBe(2);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("inlines stylesheets in place, so the cascade order survives", async () => {
    makeDoc();
    const fetchImpl = fetchStub({
      "http://127.0.0.1:47822/style-theme.css": ":root { --x: 1 }",
      "http://127.0.0.1:47822/style.css": ".message { color: red }",
    });

    const { html, stats } = await buildRenderDump(document, { fetchImpl });

    expect(stats.stylesheets).toBe(2);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html.indexOf("--x: 1")).toBeLessThan(html.indexOf("color: red"));
    expect(html).toContain('data-ompcot-href="http://127.0.0.1:47822/style-theme.css"');
  });

  it("keeps the link when a stylesheet cannot be fetched", async () => {
    makeDoc();
    const { html, stats } = await buildRenderDump(document, { fetchImpl: fetchStub({}) });

    expect(stats.stylesheets).toBe(0);
    expect(stats.stylesheetFailures).toHaveLength(2);
    expect(html).toContain('rel="stylesheet"');
  });

  it("inlines a same-origin image as a data URL", async () => {
    makeDoc();
    const bytes = new TextEncoder().encode("<svg><!-- logo --></svg>");
    const fetchImpl = fetchStub({ "http://127.0.0.1:47822/icons/logo-dark.svg": bytes });

    const { html, stats } = await buildRenderDump(document, { fetchImpl });

    expect(stats.images).toBe(1);
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain('src="icons/logo-dark.svg"');
  });

  it("records the capture metadata, the transcript census and the scroll offsets", async () => {
    makeDoc({
      html: `
        <div class="message assistant" data-finalized="true">a</div>
        <div class="message assistant">b</div>
        <div class="message user">c</div>`,
    });
    const messages = document.getElementById("messages");
    Object.defineProperty(messages, "scrollTop", { value: 1234, configurable: true });
    Object.defineProperty(messages, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(messages, "clientHeight", { value: 600, configurable: true });

    const { html, census, scroll } = await buildRenderDump(document, {
      fetchImpl: null,
      meta: { isStreaming: true, activeSessionFile: "C:\\s.jsonl" },
    });

    expect(census).toEqual({ messages: 3, assistant: 2, user: 1, finalized: 1 });
    expect(scroll).toEqual({ top: 1234, height: 5000, viewport: 600 });
    expect(html).toContain("transcript: 3 messages (assistant 2, finalized 1, user 1)");
    expect(html).toContain("isStreaming: true");
    expect(html).toContain("activeSessionFile: C:\\s.jsonl");
    expect(html).toContain('data-ompcot-scroll-top="1234"');
    expect(html).toContain("scrollTop=1234");
  });

  it("never mutates the live document", async () => {
    makeDoc({ html: '<div class="message user">hello</div>' });
    const fetchImpl = fetchStub({
      "http://127.0.0.1:47822/style.css": "body { color: red }",
    });
    await buildRenderDump(document, { fetchImpl });

    expect(document.querySelectorAll("script").length).toBe(2);
    expect(document.querySelector('link[rel="stylesheet"]')).not.toBeNull();
    expect(document.querySelector("style[data-ompcot-href]")).toBeNull();
  });
});
