import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createComposerMentions,
  filterMentionEntries,
  insertMention,
  isAbsoluteMentionDir,
  mentionTextForPath,
  relativeMentionPath,
  resolveMentionContext,
  splitMentionQuery,
} from "./composer-mentions.js";

describe("mention grammar (mirrors omp's extractFileMentions)", () => {
  it("reads the token the caret sits in", () => {
    expect(resolveMentionContext("@src/fo", 7)).toEqual({
      start: 0,
      end: 7,
      token: "@src/fo",
      query: "src/fo",
    });
    expect(resolveMentionContext("see @src/fo please", 10)).toEqual({
      start: 4,
      end: 11,
      token: "@src/fo",
      query: "src/f",
    });
    expect(resolveMentionContext("@a", 1)).toEqual({ start: 0, end: 2, token: "@a", query: "" });
    // A caret before the `@` is not inside the token.
    expect(resolveMentionContext("@a", 0)).toBeNull();
    expect(resolveMentionContext("@", 1)).toEqual({ start: 0, end: 1, token: "@", query: "" });
  });

  it("requires a mention boundary before the @", () => {
    // An email address must not open the popup.
    expect(resolveMentionContext("write to me@example.com", 20)).toBeNull();
    expect(resolveMentionContext("a@b", 3)).toBeNull();
    // …while a real boundary (whitespace, bracket, quote) does.
    expect(resolveMentionContext("(@src", 5)?.query).toBe("src");
    expect(resolveMentionContext('"@src', 5)?.query).toBe("src");
  });

  it("stops the token at whitespace, so the caret outside it has no context", () => {
    expect(resolveMentionContext("hello @a b", 10)).toBeNull();
    expect(resolveMentionContext("hello @a b", 8)?.query).toBe("a");
  });

  it("allows whitespace inside the quoted form", () => {
    expect(resolveMentionContext('@"docs/my plan', 14)).toEqual({
      start: 0,
      end: 14,
      token: '@"docs/my plan',
      query: "docs/my plan",
    });
    // Caret past the closing quote means the mention is finished.
    expect(resolveMentionContext('@"docs/my plan.md" next', 20)).toBeNull();
    // A caret inside the quotes (before the closing one) still edits the token.
    expect(resolveMentionContext('@"docs/my plan.md" next', 17)?.query).toBe("docs/my plan.md");
  });

  it("splits the query into the directory it walks and the name prefix", () => {
    expect(splitMentionQuery("src/comp")).toEqual({ dir: "src/", prefix: "comp" });
    expect(splitMentionQuery("src")).toEqual({ dir: "", prefix: "src" });
    expect(splitMentionQuery("")).toEqual({ dir: "", prefix: "" });
    expect(splitMentionQuery("C:/Us")).toEqual({ dir: "C:/", prefix: "Us" });
    expect(splitMentionQuery("src\\comp")).toEqual({ dir: "src\\", prefix: "comp" });
  });

  it("classifies absolute mention directories", () => {
    expect(isAbsoluteMentionDir("/home/me/")).toBe(true);
    expect(isAbsoluteMentionDir("C:\\src\\")).toBe(true);
    expect(isAbsoluteMentionDir("\\\\server\\share")).toBe(true);
    expect(isAbsoluteMentionDir("src/")).toBe(false);
  });

  it("filters by name prefix, case-insensitively, keeping the listing order", () => {
    const items = [
      { name: "src", isDirectory: true },
      { name: "Server.ts", isDirectory: false },
      { name: "server.js", isDirectory: false },
      { name: "main.ts", isDirectory: false },
    ];
    expect(filterMentionEntries(items, "s").map((i) => i.name)).toEqual([
      "src",
      "Server.ts",
      "server.js",
    ]);
    expect(filterMentionEntries(items, "main").map((i) => i.name)).toEqual(["main.ts"]);
    expect(filterMentionEntries(items, "zzz")).toEqual([]);
  });
});

describe("mention insertion format", () => {
  it("writes a bare path with a trailing space", () => {
    expect(mentionTextForPath("src/server.js")).toBe("@src/server.js ");
  });

  it("quotes paths the bare form cannot carry", () => {
    expect(mentionTextForPath("docs/my plan.md")).toBe('@"docs/my plan.md" ');
    // A quote without whitespace is still a valid bare token, so it stays bare.
    expect(mentionTextForPath('weird"name.ts')).toBe('@weird"name.ts ');
    // Whitespace plus a double quote falls back to the single-quoted form.
    expect(mentionTextForPath('my "odd" file.ts')).toBe("@'my \"odd\" file.ts' ");
  });

  it("keeps directories open for walking (no trailing space)", () => {
    expect(mentionTextForPath("src", { isDirectory: true })).toBe("@src/");
    expect(mentionTextForPath("my docs", { isDirectory: true })).toBe('@"my docs"/');
  });

  it("normalizes Windows separators", () => {
    expect(mentionTextForPath("src\\nested\\a.ts")).toBe("@src/nested/a.ts ");
  });

  it("prefers the workspace-relative path and keeps outside paths absolute", () => {
    expect(relativeMentionPath("D:\\ws\\src\\a.ts", "D:\\ws")).toBe("src/a.ts");
    expect(relativeMentionPath("D:\\ws\\src\\a.ts", "D:/ws/")).toBe("src/a.ts");
    expect(relativeMentionPath("D:\\other\\a.ts", "D:\\ws")).toBe("D:/other/a.ts");
    expect(relativeMentionPath("D:\\ws\\a.ts", "")).toBe("D:/ws/a.ts");
  });

  it("replaces exactly the token range and returns the caret", () => {
    const value = "look at @src/sr rest";
    const context = resolveMentionContext(value, 15);
    const next = insertMention(value, context, "@src/server.js ");
    expect(next.value).toBe("look at @src/server.js  rest");
    expect(next.caret).toBe("look at @src/server.js ".length);
  });
});

describe("composer mention popup", () => {
  let input;
  let fetchDir;
  let mentions;

  const ROOT = "D:/ws";

  beforeEach(() => {
    document.body.innerHTML =
      '<div class="composer-card"><textarea id="message-input"></textarea></div>';
    input = document.getElementById("message-input");
    fetchDir = vi.fn(async (dir) => {
      if (!dir || dir === ROOT) {
        return {
          path: ROOT,
          items: [
            { name: "src", path: `${ROOT}/src`, isDirectory: true },
            { name: "README.md", path: `${ROOT}/README.md`, isDirectory: false, size: 2048 },
            { name: "noise.txt", path: `${ROOT}/noise.txt`, isDirectory: false, size: 10 },
          ],
        };
      }
      return {
        path: dir,
        items: [{ name: "server.js", path: `${dir}/server.js`, isDirectory: false, size: 100 }],
      };
    });
    mentions = createComposerMentions({ input, fetchDir });
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const menu = () => document.querySelector(".mention-menu");
  const rows = () => Array.from(document.querySelectorAll(".mention-menu-item"));
  const key = (k) => {
    const event = new Event("keydown", { cancelable: true, bubbles: true });
    event.key = k;
    return event;
  };

  async function typeAtEnd(value) {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    await mentions.refresh();
  }

  it("lists the typed prefix and inserts the picked file as a mention", async () => {
    await typeAtEnd("@RE");
    expect(menu()).not.toBeNull();
    expect(rows().map((r) => r.textContent)).toEqual(["README.md2 KB"]);

    const event = key("Enter");
    expect(mentions.handleKeydown(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("@README.md ");
    expect(menu().classList.contains("hidden")).toBe(true);
  });

  it("walks into a directory and keeps the popup open", async () => {
    await typeAtEnd("@s");
    expect(rows().map((r) => r.textContent)).toEqual(["src/"]);

    mentions.handleKeydown(key("Tab"));
    expect(input.value).toBe("@src/");
    await tick();
    expect(rows().map((r) => r.textContent)).toEqual(["server.js100 B"]);
    expect(fetchDir).toHaveBeenCalledWith(`${ROOT}/src`);
  });

  it("cycles rows with the arrow keys and completes on click", async () => {
    await typeAtEnd("@");
    expect(rows()).toHaveLength(3);

    mentions.handleKeydown(key("ArrowDown"));
    mentions.handleKeydown(key("ArrowDown"));
    expect(rows()[2].classList.contains("active")).toBe(true);

    const click = new MouseEvent("mousedown", { cancelable: true, bubbles: true });
    rows()[2].dispatchEvent(click);
    expect(input.value).toBe("@noise.txt ");
  });

  it("Escape closes the popup and stays closed while the token is unchanged", async () => {
    await typeAtEnd("@sr");
    expect(menu().classList.contains("hidden")).toBe(false);

    const escEvent = key("Escape");
    expect(mentions.handleKeydown(escEvent)).toBe(true);
    expect(menu().classList.contains("hidden")).toBe(true);

    await mentions.refresh();
    expect(menu().classList.contains("hidden")).toBe(true);
  });

  it("stays closed for prose that only looks like a mention", async () => {
    await typeAtEnd("mail me@example.com");
    expect(menu().classList.contains("hidden")).toBe(true);
    expect(mentions.handleKeydown(key("Enter"))).toBe(false);
  });

  it("inserts mentions for paths picked outside the composer", async () => {
    await typeAtEnd("hi ");
    await mentions.insertPaths([`${ROOT}/src/server.js`, `${ROOT}/docs/my plan.md`]);
    expect(input.value).toBe('hi @src/server.js @"docs/my plan.md" ');
    expect(input.selectionStart).toBe(input.value.length);
  });
});
