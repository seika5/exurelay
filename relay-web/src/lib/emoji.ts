/**
 * The emoji the reaction picker offers: common ones by group, drawn with the device's own emoji font (nothing to
 * download). A web app can't open the emoji keyboard as a picker, so this is our own list.
 */

/** The default quick reactions: the phone sheet's row and the top of the picker. Changed in Settings → General. */
export const DEFAULT_QUICK_EMOJI = ["❤️", "👍", "👎", "🤣", "🎉"];
const QUICK_KEY = "relay.quickEmoji";

/** This device's 5 quick reactions. */
export function getQuickEmoji(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(QUICK_KEY) ?? "null");
    if (Array.isArray(saved) && saved.length === 5 && saved.every((e) => typeof e === "string" && e.length > 0 && e.length <= 16)) return saved;
  } catch {
    // Unreadable: the defaults.
  }
  return DEFAULT_QUICK_EMOJI;
}

export function setQuickEmoji(list: string[]): void {
  try {
    localStorage.setItem(QUICK_KEY, JSON.stringify(list));
  } catch {
    // Not saved.
  }
}

const groups: [string, string][] = [
  [
    "Smileys",
    "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾",
  ],
  [
    "People",
    "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 💪 🦾 🦵 🦶 👂 👃 🧠 👀 👁️ 👅 👄 🫶 🙋 🙅 🙆 🤷 🤦 🙇 💁 🧑‍💻 🕺 💃 🏃 🚶 🧍 👶 🧒 🧑 🧓",
  ],
  [
    "Hearts",
    "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💟 ❣️ 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤",
  ],
  [
    "Animals",
    "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐟 🐬 🐳 🦈 🐊 🐘 🦒 🐪 🐕 🐈 🐓 🦃 🕊️ 🌵 🌲 🌳 🌴 🌱 🍀 🍁 🍂 🌷 🌹 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊",
  ],
  [
    "Food",
    "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥦 🍄 🥜 🍞 🥐 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍦 🍰 🎂 🧁 🍩 🍪 🍫 🍬 🍭 🍿 ☕ 🍵 🧃 🥤 🧋 🍺 🍻 🥂 🍷 🍸 🍹 🧉",
  ],
  [
    "Activities",
    "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏒 🥊 🥋 ⛳ 🎣 🎿 🏂 🏋️ 🚴 🏊 🧗 🏆 🥇 🥈 🥉 🏅 🎖️ 🎫 🎟️ 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🧩 🎉 🎊 🎈 🎁 🎀 🪅 🎃 🎄 🎆 🎇",
  ],
  [
    "Travel & things",
    "🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚲 🛴 🏍️ ✈️ 🚀 🛸 🚁 ⛵ 🚢 🗺️ 🏔️ 🏕️ 🏖️ 🏝️ 🏠 🏢 🏰 🗼 🗽 ⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 📷 📸 📹 🎥 📞 ☎️ 📺 📻 ⏰ ⏳ 💡 🔦 🕯️ 💸 💵 💰 💳 💎 🔧 🔨 🛠️ 🔑 🗝️ 🔒 🔓 🧲 🧪 💊 🩹 🧸 📦 📫 📝 📌 📎 ✂️ 📅 📈 📉 📚 📖 🔍",
  ],
  [
    "Symbols",
    "✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ❓ ❔ ❗ ❕ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔞 ♻️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔶 🔷 ⬆️ ⬇️ ⬅️ ➡️ ↩️ 🔁 🔄 ▶️ ⏸️ ⏹️ ⏩ ⏪ 🔔 🔕 🔇 🔊 📣 💤 🆗 🆒 🆕 🆙 🆘 🔝 🔜 💲 ©️ ®️ ™️ 🏁 🚩 🏳️ 🏴 🏳️‍🌈",
  ],
];

/** The picker's groups, each a name and its emoji. */
export const EMOJI_GROUPS: { name: string; emoji: string[] }[] = groups.map(([name, list]) => ({ name, emoji: list.split(" ") }));
