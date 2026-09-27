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
});
