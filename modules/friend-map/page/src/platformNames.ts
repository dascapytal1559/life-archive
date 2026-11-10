// What each platform is called on the page: "WhatsApp", "iMessage", and the phone's own calls "Phone".

const PLATFORM_NAMES: Record<string, string> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp", imessage: "iMessage", telegram: "Telegram", x: "X", signal: "Signal", discord: "Discord", wechat: "WeChat", phone: "Phone" };

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}
