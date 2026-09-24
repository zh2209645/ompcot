// omp binary not-found errors — shared detection + user-facing hint.
//
// When the Rust host cannot resolve an `omp` binary, spawn errors surface in
// the UI as plain strings starting with `Could not find omp binary` (stable
// prefix from the backend). These helpers keep the matching — and the hint
// pointing users at Settings → Runtime, where a binary can be picked manually
// — in one place so every surface (workspace actions, dialogs) stays
// consistent.

const OMP_BINARY_NOT_FOUND_PATTERN = /could not find omp binary/i;
const OMP_BINARY_HINT = "set the omp binary path in Settings";

export function isOmpBinaryNotFoundError(error) {
  const message = typeof error === "string" ? error : error?.message || String(error || "");
  return OMP_BINARY_NOT_FOUND_PATTERN.test(message);
}

// Append a pointer to Settings when (and only when) the error is a
// omp-binary-not-found failure. All other messages pass through untouched.
export function appendOmpBinaryHint(message) {
  const text = String(message || "");
  if (!isOmpBinaryNotFoundError(text)) return text;
  if (text.toLowerCase().includes(OMP_BINARY_HINT.toLowerCase())) return text;
  return `${text} — ${OMP_BINARY_HINT}`;
}
