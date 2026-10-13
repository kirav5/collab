// Reads messages with the real model and prints what each step decided (category, fields, draft or problem).
//   GOOGLE_CLOUD_PROJECT=collab-55 GOOGLE_CLOUD_LOCATION=global node tools/read-probe.ts sell "text" [find "text" ...]
import { geminiFromEnv } from "../src/ai/gemini.ts";
import { decide } from "../src/ai/decide.ts";
import { ClassifyTask, ListingFieldsTask, read } from "../src/market/read.ts";
import { domain } from "../src/market/domains.ts";
import { resolve } from "../src/market/places.ts";

const model = geminiFromEnv()!;
const here = resolve("Bengaluru");
const args = process.argv.slice(2);
for (let i = 0; i + 1 < args.length; i += 2) {
  const side = args[i] as "sell" | "find", text = args[i + 1];
  const c = await decide(model, ClassifyTask, { text });
  const d = c.output && c.output !== "none" ? domain(c.output) : null;
  const f = d ? await decide(model, ListingFieldsTask, { text, domain: d, side }) : null;
  const r = await read(text, side, model, Math.floor(Date.now() / 1000), here);
  console.log(JSON.stringify({ text, category: c.output, fields: f?.output, result: r.draft ? (r.draft.kind === "offer" ? { offer: r.draft.offer.title, price: r.draft.offer.price, attrs: r.draft.offer.attributes } : { need: r.draft.need.category, maxPrice: r.draft.need.maxPrice, place: r.draft.need.place.name }) : r.problem }, null, 1));
}
