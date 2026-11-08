/**
 * Per-recipient push limits (DESIGN.md §8 "@mentions"): however many people mention or ring someone, they get at
 * most a few pushes a minute. Extra mentions aren't lost: they show, highlighted, the next time the app opens.
 * Memory only, like the token buckets: nothing about who was notified is written down.
 */
export const PUSH_LIMITS = {
  mention: { max: 5, windowMs: 60_000 },
  everyone: { max: 1, windowMs: 60_000 },
  ring: { max: 1, windowMs: 30_000 },
  // Every-message and call-start notifications, only if the admin allows them (directory notifyAll).
  message: { max: 6, windowMs: 60_000 },
  call: { max: 2, windowMs: 60_000 },
};

export function createPushLimiter({ now = () => Date.now(), limits = PUSH_LIMITS } = {}) {
  const sent = new Map(); // `${kind}:${member}` -> timestamps in the window

  /** Take one push for this member and kind, or false if they're at the limit. */
  function take(kind, member) {
    const limit = limits[kind];
    if (!limit) return false;
    const key = `${kind}:${member}`;
    const t = now();
    const recent = (sent.get(key) ?? []).filter((at) => t - at < limit.windowMs);
    if (recent.length >= limit.max) {
      sent.set(key, recent);
      return false;
    }
    recent.push(t);
    sent.set(key, recent);
    return true;
  }

  /** Forget windows that have passed (called now and then). */
  function sweep() {
    const t = now();
    for (const [key, list] of sent) {
      const kind = key.slice(0, key.indexOf(":"));
      const rest = list.filter((at) => t - at < (limits[kind]?.windowMs ?? 0));
      if (rest.length) sent.set(key, rest);
      else sent.delete(key);
    }
  }

  return { take, sweep };
}
