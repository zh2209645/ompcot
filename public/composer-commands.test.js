import { JSDOM } from "jsdom";
import { describe, expect, test, vi } from "vitest";
import {
  createComposerCommands,
  createComposerQueue,
  filterSlashCommands,
  isSlashCommand,
  isSlashStreamRejection,
  resolveDelivery,
  resolveSlashContext,
  SLASH_STREAM_REJECTION,
} from "./composer-commands.js";

const COMMANDS = [
  { name: "compact", description: "Compact context", source: "extension" },
  { name: "copy", description: "Copy last message" },
  { name: "context", description: "Show context", source: "skill" },
];

class MockWsClient extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
    return `req-${this.sent.length}`;
  }

  respond(requestId, payload) {
    this.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { requestId, success: true, data: payload },
      }),
    );
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function boot({ streaming = false } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div class="composer-card">
        <textarea id="message-input"></textarea>
        <div class="composer-toolbar">
          <div class="delivery-toggle hidden" id="delivery-toggle">
            <button type="button" class="delivery-option" data-mode="queue">Queue</button>
            <button type="button" class="delivery-option" data-mode="steer">Steer now</button>
          </div>
        </div>
      </div>
    </body></html>`,
    { url: "http://localhost/" },
  );
  globalThis.document = dom.window.document;

  const input = document.getElementById("message-input");
  const toggleEl = document.getElementById("delivery-toggle");
  const ws = new MockWsClient();
  const onSubmit = vi.fn();
  const queueSlash = vi.fn();
  const showSteerQueued = vi.fn();
  let isStreaming = streaming;

  // Mirror app.js wiring: consumed keys skip the Enter-send path.
  const api = createComposerCommands({
    input,
    wsClient: ws,
    isStreaming: () => isStreaming,
    onSubmit,
    queueSlash,
    showSteerQueued,
    toggleEl,
  });
  input.addEventListener("keydown", (e) => {
    if (api.handleKeydown(e)) e.preventDefault();
  });

  const type = (value) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };

  return {
    dom,
    input,
    toggleEl,
    ws,
    api,
    onSubmit,
    queueSlash,
    showSteerQueued,
    setStreaming: (value) => {
      isStreaming = value;
    },
    type,
    press: (key) => {
      const event = new dom.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      return event;
    },
  };
}

/** Types "/" and answers the first list_commands RPC so the cache is warm. */
async function primeCommands(ctx, commands = COMMANDS) {
  ctx.type("/");
  await tick();
  const request = ctx.ws.sent.find((cmd) => cmd.type === "list_commands");
  const requestId = ctx.ws.sent.indexOf(request) + 1;
  ctx.ws.respond(`req-${requestId}`, { commands, available: true });
  await tick();
}

function rows(ctx) {
  return Array.from(ctx.dom.window.document.querySelectorAll(".slash-menu-item"));
}

describe("slash context + filtering helpers", () => {
  test("resolves the first-token context only while the caret is inside it", () => {
    expect(resolveSlashContext("/com", 3)).toEqual({ token: "/com", tokenEnd: 4 });
    expect(resolveSlashContext("/com args", 3)).toEqual({ token: "/com", tokenEnd: 4 });
    expect(resolveSlashContext("/com args", 6)).toBeNull();
    expect(resolveSlashContext("say /com", 6)).toBeNull();
    expect(resolveSlashContext("/com", null)).toEqual({ token: "/com", tokenEnd: 4 });
  });

  test("filters commands by case-insensitive prefix", () => {
    const names = filterSlashCommands(COMMANDS, "/CO").map((cmd) => cmd.name);
    expect(names).toEqual(["compact", "copy", "context"]);
    expect(filterSlashCommands(COMMANDS, "/copy")).toEqual([COMMANDS[1]]);
    expect(filterSlashCommands(COMMANDS, "/zzz")).toEqual([]);
  });

  test("detects slash commands in submitted messages", () => {
    expect(isSlashCommand("/compact extra")).toBe(true);
    expect(isSlashCommand(" /help")).toBe(true);
    expect(isSlashCommand("hello /help")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});

describe("slash popup", () => {
  test("fetches commands lazily, renders filtered rows with descriptions", async () => {
    const ctx = boot();
    ctx.type("/co");
    await tick();

    // Request went out; popup stays hidden until the response arrives.
    expect(ctx.ws.sent).toContainEqual({ type: "list_commands" });
    expect(ctx.api.isPopupOpen()).toBe(false);

    ctx.ws.respond("req-1", { commands: COMMANDS, available: true });
    await tick();

    expect(ctx.api.isPopupOpen()).toBe(true);
    const visible = rows(ctx).map((row) => row.querySelector(".slash-menu-name").textContent);
    expect(visible).toEqual(["/compact", "/copy", "/context"]);
    expect(rows(ctx)[0].querySelector(".slash-menu-desc").textContent).toBe("Compact context");
    expect(rows(ctx)[0].querySelector(".slash-menu-source").textContent).toBe("extension");
  });

  test("hides the popup when available:false, then refetches on the next open", async () => {
    const ctx = boot();
    ctx.type("/co");
    await tick();
    ctx.ws.respond("req-1", { commands: COMMANDS, available: false });
    await tick();
    expect(ctx.api.isPopupOpen()).toBe(false);

    // Close (empty input), then re-open: the empty cache triggers a refetch.
    ctx.type("");
    ctx.type("/");
    await tick();
    expect(ctx.ws.sent).toHaveLength(2);

    ctx.ws.respond("req-2", { commands: COMMANDS, available: true });
    await tick();
    expect(ctx.api.isPopupOpen()).toBe(true);
  });

  test("F13: replies correlated via the server's `id` field populate the list", async () => {
    const ctx = boot();
    ctx.type("/co");
    await tick();
    expect(ctx.ws.sent).toContainEqual({ type: "list_commands" });

    // The embedded server echoes the requestId back as `id`, not
    // `requestId` — correlation must accept both spellings.
    ctx.ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-1", success: true, data: { commands: COMMANDS, available: true } },
      }),
    );
    await tick();

    expect(ctx.api.isPopupOpen()).toBe(true);
    expect(rows(ctx).map((row) => row.querySelector(".slash-menu-name").textContent)).toEqual([
      "/compact",
      "/copy",
      "/context",
    ]);
  });

  test("a warm cache serves later opens without re-querying", async () => {
    const ctx = boot();
    await primeCommands(ctx);
    expect(ctx.api.isPopupOpen()).toBe(true);

    ctx.type("");
    ctx.type("/copy");
    await tick();
    expect(ctx.api.isPopupOpen()).toBe(true);
    expect(ctx.ws.sent).toHaveLength(1);
    const visible = rows(ctx).map((row) => row.querySelector(".slash-menu-name").textContent);
    expect(visible).toEqual(["/copy"]);
  });

  test("does not open when the caret has moved past the command token", async () => {
    const ctx = boot();
    ctx.type("/compact with args");
    await tick();
    expect(ctx.ws.sent).toHaveLength(0);
    expect(ctx.api.isPopupOpen()).toBe(false);
  });

  test("closes on Esc without bubbling to the document abort handler", async () => {
    const ctx = boot();
    await primeCommands(ctx);
    expect(ctx.api.isPopupOpen()).toBe(true);

    let documentSawIt = false;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") documentSawIt = true;
    });

    ctx.press("Escape");
    expect(ctx.api.isPopupOpen()).toBe(false);
    expect(documentSawIt).toBe(false);
  });
});

describe("slash popup keyboard", () => {
  test("ArrowDown/ArrowUp cycle with wrap-around", async () => {
    const ctx = boot();
    await primeCommands(ctx);
    ctx.type("/c");
    await tick();
    expect(rows(ctx)).toHaveLength(3);

    const activeName = () =>
      ctx.dom.window.document.querySelector(".slash-menu-item.active .slash-menu-name")
        ?.textContent;

    expect(activeName()).toBe("/compact");
    ctx.press("ArrowDown");
    expect(activeName()).toBe("/copy");
    ctx.press("ArrowDown");
    expect(activeName()).toBe("/context");
    ctx.press("ArrowDown");
    expect(activeName()).toBe("/compact");
    ctx.press("ArrowUp");
    expect(activeName()).toBe("/context");
  });

  test("Tab completes the active command with a trailing space", async () => {
    const ctx = boot();
    await primeCommands(ctx);
    ctx.type("/com");
    await tick();
    ctx.press("Tab");
    expect(ctx.input.value).toBe("/compact ");
    expect(ctx.input.selectionStart).toBe(ctx.input.value.length);
    expect(ctx.api.isPopupOpen()).toBe(false);
    expect(ctx.onSubmit).not.toHaveBeenCalled();
  });

  test("Enter completes when args may follow, and submits on an exact match", async () => {
    const ctx = boot();
    await primeCommands(ctx);

    // `/com` + Enter → completes, does not submit.
    ctx.type("/com");
    await tick();
    ctx.press("Enter");
    expect(ctx.input.value).toBe("/compact ");
    expect(ctx.onSubmit).not.toHaveBeenCalled();

    // `/compact` + Enter → exact match, no args → submit via the normal path.
    ctx.type("/compact");
    await tick();
    const enterEvent = ctx.press("Enter");
    expect(ctx.onSubmit).toHaveBeenCalledTimes(1);
    expect(ctx.input.value).toBe("/compact");
    expect(ctx.api.isPopupOpen()).toBe(false);
    // Default (newline insertion) is suppressed — the input stays clean.
    expect(enterEvent.defaultPrevented).toBe(true);
  });

  test("clicking a row completes the command", async () => {
    const ctx = boot();
    await primeCommands(ctx);
    ctx.type("/con");
    await tick();
    rows(ctx)[0].click();
    expect(ctx.input.value).toBe("/context ");
    expect(ctx.api.isPopupOpen()).toBe(false);
  });
});

describe("delivery mode (queue vs steer)", () => {
  test("resolveDelivery: streaming slash always queues, plain messages follow the toggle", () => {
    expect(resolveDelivery({ message: "hi", isStreaming: false, deliveryMode: "queue" })).toBe(
      "send",
    );
    expect(
      resolveDelivery({ message: "/compact", isStreaming: false, deliveryMode: "queue" }),
    ).toBe("send");
    expect(resolveDelivery({ message: "/compact", isStreaming: true, deliveryMode: "steer" })).toBe(
      "queue",
    );
    expect(resolveDelivery({ message: "hi", isStreaming: true, deliveryMode: "queue" })).toBe(
      "queue",
    );
    expect(resolveDelivery({ message: "hi", isStreaming: true, deliveryMode: "steer" })).toBe(
      "steer",
    );
  });

  test("toggle appears only while streaming with non-slash text; defaults to Queue", async () => {
    const ctx = boot({ streaming: true });
    ctx.type("hello");
    await tick();
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(false);
    expect(ctx.api.getDeliveryMode()).toBe("queue");
    expect(ctx.toggleEl.querySelector('[data-mode="queue"]').getAttribute("aria-checked")).toBe(
      "true",
    );

    // Slash text → toggle hides (slash always queues).
    ctx.type("/compact");
    await tick();
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(true);

    // Back to plain text, pick Steer now.
    ctx.type("hello");
    ctx.toggleEl.querySelector('[data-mode="steer"]').click();
    expect(ctx.api.getDeliveryMode()).toBe("steer");
    expect(ctx.toggleEl.querySelector('[data-mode="steer"]').getAttribute("aria-checked")).toBe(
      "true",
    );

    // Idle again → toggle hides and the mode resets to the Queue default.
    ctx.setStreaming(false);
    ctx.api.refresh();
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(true);
    expect(ctx.api.getDeliveryMode()).toBe("queue");
  });

  test("sendSteerNow emits the steer RPC and mirrors the message in the queue", () => {
    const ctx = boot({ streaming: true });
    ctx.api.sendSteerNow("stop and reconsider");
    expect(ctx.ws.sent).toContainEqual({ type: "steer", message: "stop and reconsider" });
    expect(ctx.showSteerQueued).toHaveBeenCalledWith("stop and reconsider");
  });

  test("F14: beginSend resolves Steer-now BEFORE the post-send refresh resets the toggle", () => {
    const ctx = boot({ streaming: true });
    ctx.type("pivot please");
    ctx.toggleEl.querySelector('[data-mode="steer"]').click();
    expect(ctx.api.getDeliveryMode()).toBe("steer");

    const plan = ctx.api.beginSend();

    // The decision was captured while the toggle still said "steer"…
    expect(plan).toEqual({ message: "pivot please", delivery: "steer" });
    // …even though clearing the input + refreshing the controls reset the
    // visible mode back to Queue — reading the mode after the reset is what
    // used to downgrade the send.
    expect(ctx.input.value).toBe("");
    expect(ctx.api.getDeliveryMode()).toBe("queue");
  });

  test("F14: wired like app.js, a steer-mode send emits the steer RPC instead of queueing", () => {
    const ctx = boot({ streaming: true });
    const steerSent = [];
    const originalSend = ctx.ws.send.bind(ctx.ws);
    ctx.ws.send = (data) => {
      steerSent.push(data);
      return originalSend(data);
    };
    ctx.type("pivot please");
    ctx.toggleEl.querySelector('[data-mode="steer"]').click();

    const plan = ctx.api.beginSend();
    if (plan.delivery === "steer") ctx.api.sendSteerNow(plan.message);

    expect(steerSent).toContainEqual({ type: "steer", message: "pivot please" });
    expect(ctx.showSteerQueued).toHaveBeenCalledWith("pivot please");
  });

  test("slash-while-streaming rejection is converted back into a queued message", () => {
    const ctx = boot({ streaming: true });

    // Nothing pending → the error surfaces normally.
    expect(ctx.api.consumeStreamRejection(SLASH_STREAM_REJECTION)).toBe(false);

    ctx.api.sendSteerNow("/compact");
    expect(ctx.api.consumeStreamRejection(SLASH_STREAM_REJECTION)).toBe(true);
    expect(ctx.queueSlash).toHaveBeenCalledWith("/compact");

    // Unrelated errors and non-slash steers are not intercepted.
    ctx.api.sendSteerNow("plain text");
    expect(ctx.api.consumeStreamRejection(SLASH_STREAM_REJECTION)).toBe(false);
    expect(ctx.api.consumeStreamRejection("some other server error")).toBe(false);
  });

  test("isSlashStreamRejection matches only the exact server error", () => {
    expect(isSlashStreamRejection(SLASH_STREAM_REJECTION)).toBe(true);
    expect(isSlashStreamRejection(`  ${SLASH_STREAM_REJECTION} `)).toBe(true);
    expect(isSlashStreamRejection("cannot run while streaming")).toBe(false);
    expect(isSlashStreamRejection(undefined)).toBe(false);
  });
});

describe("createComposerQueue (F15)", () => {
  test("steer echoes render in the strip but are never flushed", () => {
    const queue = createComposerQueue();
    queue.queuePrompt("/compact", { kind: "slash" });
    queue.addSteerEcho("already steered");
    queue.queuePrompt("follow-up", { kind: "queue" });

    const snapshot = queue.snapshot();
    expect(snapshot.map((entry) => entry.message)).toEqual([
      "/compact",
      "follow-up",
      "already steered",
    ]);
    // Only the genuinely pending commands are interactive/flushable; the
    // steer echo is a visual-only acknowledgement.
    expect(snapshot.filter((entry) => entry.flushable).map((entry) => entry.message)).toEqual([
      "/compact",
      "follow-up",
    ]);
    expect(snapshot.find((entry) => entry.kind === "steer").flushable).toBe(false);
    expect(snapshot.find((entry) => entry.kind === "steer").item).toBeNull();

    // Flushes drain pending items only, oldest first…
    expect(queue.takeFlushable()).toMatchObject({ message: "/compact", kind: "slash" });
    expect(queue.takeFlushable()).toMatchObject({ message: "follow-up", kind: "queue" });
    expect(queue.takeFlushable()).toBeNull();
    expect(queue.flushableCount).toBe(0);

    // …while the steer echo survives flushes until its user-message echo
    // retires it.
    expect(queue.isEmpty).toBe(false);
    expect(queue.removeSteerEcho("already steered")).toBe(true);
    expect(queue.isEmpty).toBe(true);
    expect(queue.removeSteerEcho("already steered")).toBe(false);
  });

  test("cancel/promote remove only the targeted pending item", () => {
    const queue = createComposerQueue();
    queue.queuePrompt("one", { kind: "queue" });
    queue.queuePrompt("two", { kind: "queue" });
    const snapshot = queue.snapshot();
    const [first, second] = snapshot.map((entry) => entry.item);

    queue.remove(first);
    expect(queue.snapshot().map((entry) => entry.message)).toEqual(["two"]);

    queue.remove(second);
    expect(queue.snapshot()).toEqual([]);
    expect(queue.flushableCount).toBe(0);
  });

  test("clear empties pending items and steer echoes together", () => {
    const queue = createComposerQueue();
    queue.queuePrompt("/compact", { kind: "slash" });
    queue.addSteerEcho("steered away");
    queue.clear();
    expect(queue.isEmpty).toBe(true);
    expect(queue.snapshot()).toEqual([]);
  });
});
