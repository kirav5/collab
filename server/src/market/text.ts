// Small text checks the tasks share: "is this in what they wrote", and the numbers written in a text.

/** Lower-cased, apostrophe-folded, whitespace-collapsed. */
export const fold = (s: string) => s.toLowerCase().replace(/’/g, "'").split(/\s+/).filter(Boolean).join(" ");
export const contains = (text: string, part: string) => fold(text).includes(fold(part));

/** Numbers as written ("₹2,400" → 2400, "1.5" → 1.5). */
export function numbers(s: string): number[] {
  return (s.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

const SCALES = [1, 1_000, 100_000, 10_000_000];
/** A value is grounded if it's a written number at some scale ("80 lakh" → 8,000,000). */
export function grounded(v: number, text: string): boolean {
  return numbers(text).some(w => SCALES.some(s => Math.round(w * s) === Math.round(v)));
}

/** No contact details a model might make up or pass on. */
export const hasContact = (s: string) => /[\w.+-]+@[\w-]+\.[\w.]+/.test(s) || /\+?\d[\d\s-]{8,}\d/.test(s) || /https?:/i.test(s);
