// The privacy wall on every message that crosses between agents (Collab's Engagements cleaning): e-mail addresses,
// phone numbers and links are removed, and the names of the owner's other people become "a contact" — whatever the
// topic. Names are data (the owner's contacts); e-mail/phone/link shapes are structural.

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export function clean(text: string, names: { name: string; replacement: string }[] = [], keep: string[] = []): string {
  let out = text.replace(/’/g, "'").replace(EMAIL, "[email removed]").replace(PHONE, "[number removed]").replace(LINK, "[link removed]");
  const kept = new Set(keep.map(k => k.toLowerCase()));
  for (const { name, replacement } of [...names].sort((a, b) => b.name.length - a.name.length)) {
    if (!name.trim() || kept.has(name.toLowerCase())) continue;
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), replacement);
  }
  return out;
}
