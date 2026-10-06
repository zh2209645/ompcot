//
// Waiters for omp's `session_branch` event — the completion channel for the
// desktop broker's fire-and-forget fork frame (the RPC reply goes to a stdout
// the broker relays only narrowly). Since omp 18.4.11 the event carries
// `reason` ("branch" | "fork" | "btw") because three transitions share it, so
// a waiter must only resolve for the transition it sent for: a `/btw`
// promotion or a rewind landing mid-wait used to confirm a fork that never
// happened.
//

/**
 * @returns {{
 *   waitFor: (reason: string|null, timeoutMs: number) => Promise<boolean>,
 *   handle: (event: {reason?: string|null}) => void,
 * }}
 */
export function createSessionBranchWaiters() {
  const waiters = new Set();

  function matches(waiter, eventReason) {
    // omp <18.4.11 events carry no reason; those builds put one transition
    // through this channel, so an unlabelled event matches any waiter (and a
    // reason-less waiter is the legacy call shape).
    return waiter.reason == null || eventReason == null || waiter.reason === eventReason;
  }

  return {
    /** Resolve true on a matching `session_branch`, false when `timeoutMs` passes. */
    waitFor(reason, timeoutMs) {
      return new Promise((resolve) => {
        const waiter = { resolve, reason };
        waiters.add(waiter);
        setTimeout(() => {
          if (waiters.delete(waiter)) resolve(false);
        }, timeoutMs);
      });
    },

    /** Feed one `session_branch` event (app.js's event switch). */
    handle(event) {
      const eventReason = event?.reason ?? null;
      for (const waiter of [...waiters]) {
        if (matches(waiter, eventReason)) {
          waiters.delete(waiter);
          waiter.resolve(true);
        }
      }
    },
  };
}
