import { describe, expect, test } from "vitest";
import { resolveTranscriptOpenAction } from "./transcript-open.js";

const LIVE = "C:/omp/sessions/p/root/session.jsonl";
const OTHER = "C:/omp/sessions/p/root/other.jsonl";
const AGENT = "C:/omp/sessions/p/root/session.jsonl/Explorer.jsonl";

describe("resolveTranscriptOpenAction", () => {
  test("the session this window is live on is handed back to the live view", () => {
    expect(resolveTranscriptOpenAction({ sessionFile: LIVE }, [null, LIVE])).toBe("live");
  });

  test("any other transcript is a read-only peek — never a session switch", () => {
    // Both a subagent transcript and *another* session's main transcript are
    // views: opening them through the selection flow is what re-routed the
    // window (queue clear, state reset, dedicated-process spawn).
    expect(resolveTranscriptOpenAction({ sessionFile: AGENT }, [LIVE])).toBe("peek");
    expect(resolveTranscriptOpenAction({ sessionFile: OTHER }, [LIVE])).toBe("peek");
  });

  test("no live session known yet means peek, not switch", () => {
    expect(resolveTranscriptOpenAction({ sessionFile: OTHER }, [null, undefined, ""])).toBe("peek");
  });

  test("a missing or malformed path is a peek (the caller renders the error)", () => {
    expect(resolveTranscriptOpenAction({}, [LIVE])).toBe("peek");
    expect(resolveTranscriptOpenAction({ sessionFile: null }, [LIVE])).toBe("peek");
    expect(resolveTranscriptOpenAction({ sessionFile: "" }, [LIVE])).toBe("peek");
  });

  test("the main row hands the live view back, whatever path the roster named", () => {
    // omp registers the main agent once, at process start: after a
    // `new_session` / switch / fork the row still names the old session. The
    // click means "show the live session", so it must not be compared against
    // the live files at all — that comparison is what peeked another session's
    // transcript while the window was on the live one.
    const stale = "C:/omp/sessions/p/root/old-session.jsonl";
    expect(resolveTranscriptOpenAction({ sessionFile: stale, kind: "main" }, [LIVE])).toBe("live");
    expect(resolveTranscriptOpenAction({ sessionFile: null, kind: "main" }, [])).toBe("live");
    // Subagent rows keep the path rule.
    expect(resolveTranscriptOpenAction({ sessionFile: AGENT, kind: "sub" }, [LIVE])).toBe("peek");
  });

  test("the same session is recognised across path spellings", () => {
    // Producers hand over native, slash-separated, `\\?\`-prefixed and
    // differently-cased paths for one file; a literal comparison missed the
    // window's own session and peeked it as if it were another.
    const native = "C:\\omp\\sessions\\p\\root\\session.jsonl";
    const liveFiles = [LIVE];

    expect(resolveTranscriptOpenAction({ sessionFile: native }, liveFiles)).toBe("live");
    expect(
      resolveTranscriptOpenAction(
        { sessionFile: "\\\\?\\C:\\omp\\sessions\\p\\root\\session.jsonl" },
        liveFiles,
      ),
    ).toBe("live");
    expect(resolveTranscriptOpenAction({ sessionFile: LIVE.toLowerCase() }, liveFiles)).toBe(
      "live",
    );
    // A trailing separator is the same file too, but a *different* session is
    // still a peek.
    expect(resolveTranscriptOpenAction({ sessionFile: `${LIVE}/` }, liveFiles)).toBe("live");
    expect(resolveTranscriptOpenAction({ sessionFile: OTHER }, liveFiles)).toBe("peek");
  });
});
