/**
 * A short tap of vibration. Android browsers have navigator.vibrate; Safari on iPhone doesn't, but toggling an
 * <input type="checkbox" switch> (iOS 18 and later) gives the system's own light haptic, so that's used there. Where
 * neither works this does nothing. iPhone may only play it straight from a touch, not from a timer.
 */
let toggle: HTMLLabelElement | null = null;

export function haptic(): void {
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(10);
    return;
  }
  try {
    if (!toggle) {
      toggle = document.createElement("label");
      toggle.setAttribute("aria-hidden", "true");
      toggle.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      toggle.appendChild(input);
      document.body.appendChild(toggle);
    }
    toggle.click();
  } catch {
    // No haptics here.
  }
}
