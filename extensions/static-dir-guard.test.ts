import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideStaticDir } from "./embedded-server.ts";

describe("static root containment", () => {
  const root = path.resolve("/srv/ompcot/public");

  it("accepts files below the root", () => {
    expect(isInsideStaticDir(root, path.join(root, "index.html"))).toBe(true);
    expect(isInsideStaticDir(root, path.join(root, "assets", "app.js"))).toBe(true);
    expect(isInsideStaticDir(root, root)).toBe(true);
  });

  it("accepts a root spelled with the other separator", () => {
    // The regression this guard was rewritten for: the Rust host passes native
    // separators while a hand-set OMCOT_STATIC_DIR may use `/`. On Windows the
    // raw `startsWith` compared `D:\...\public\index.html` against
    // `D:/.../public` and answered 403 for every asset (the UI never loaded).
    expect(isInsideStaticDir(root, `${root.replace(/\\/g, "/")}/index.html`)).toBe(true);
    expect(isInsideStaticDir(root.replace(/\\/g, "/"), path.join(root, "cost.html"))).toBe(true);
  });

  it("rejects traversal and sibling directories", () => {
    expect(isInsideStaticDir(root, path.join(root, "..", "secret.txt"))).toBe(false);
    expect(isInsideStaticDir(root, path.join(root, "..", "public-other", "app.js"))).toBe(false);
    // A prefix-sharing sibling is not "inside" the root (a bare startsWith said
    // it was).
    expect(isInsideStaticDir(root, `${root}-other${path.sep}app.js`)).toBe(false);
    expect(isInsideStaticDir(root, path.resolve(path.sep, "etc", "passwd"))).toBe(false);
  });
});
