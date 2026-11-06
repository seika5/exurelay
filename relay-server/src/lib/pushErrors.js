/**
 * Push service answers that mean a subscription will never work again, so the server drops it (routes/push.js) and
 * the member's switch shows off until they turn it on again:
 * - 404, 410: gone (the app was removed, or notifications were turned off in the phone's settings);
 * - 400: the push service doesn't accept this subscription (e.g. a bad device token);
 * - 401, 403: it refuses our key for it (e.g. the subscription was made with an older VAPID key).
 * Anything else (429 too many, 5xx, no answer) may pass, so the subscription is kept.
 */
const PERMANENT = new Set([400, 401, 403, 404, 410]);

export function isPermanentPushError(statusCode) {
  return PERMANENT.has(statusCode);
}
