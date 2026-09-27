/**
 * Composer textarea sizing and caret visibility.
 *
 * `#message-input` auto-grows to its CSS `max-height` and scrolls internally
 * past that. Every re-measure has to start from `height: auto`, and the
 * browser clamps the internal scroll while the box is momentarily tall enough
 * to hold the whole draft — so a *programmatic* write (the restored
 * undeliverable message, a voice transcript, a command picked from the slash
 * popup, a file path inserted from the browser) left a long draft showing its
 * FIRST lines with the caret and the end of the text off-screen below.
 *
 * Writing through these helpers re-measures and then reveals the end of the
 * draft whenever the caret sits at the end — the case every one of those
 * flows ends in. A caret placed deliberately elsewhere (an insert at a
 * mid-draft caret) keeps whatever scroll position the browser chose.
 */
export const COMPOSER_MAX_HEIGHT = 160;

/**
 * Re-measure the textarea to its content height (capped) and reveal the end
 * of the draft when the caret is already there.
 *
 * @param {HTMLTextAreaElement} input
 * @param {object} [options]
 * @param {number} [options.maxHeight] - px cap, mirroring the CSS max-height
 */
export function syncComposerHeight(input, { maxHeight = COMPOSER_MAX_HEIGHT } = {}) {
  if (!input?.style) return;
  const caretAtEnd =
    typeof input.selectionStart === "number" && input.selectionStart === input.value.length;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  if (caretAtEnd) input.scrollTop = input.scrollHeight;
}

/**
 * Replace the composer text and leave the caret (and the viewport) at its end.
 *
 * @param {HTMLTextAreaElement} input
 * @param {string} text
 * @param {object} [options] - forwarded to {@link syncComposerHeight}
 */
export function setComposerText(input, text, options = {}) {
  if (!input) return;
  input.value = text ?? "";
  const end = input.value.length;
  try {
    input.setSelectionRange(end, end);
  } catch {
    // A client without selection APIs still gets the value + height below.
  }
  syncComposerHeight(input, options);
  // setSelectionRange put the caret at the end, so the sync above already
  // jumped to the bottom; keep this explicit for doubles without selection.
  input.scrollTop = input.scrollHeight;
}
