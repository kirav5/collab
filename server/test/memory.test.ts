// What the owner answered is kept (Private) so they aren't asked twice: the same question in other words is
// recognised, a different one isn't, contact details are never reused, and only answers the owner allowed are given
// again by their agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { likeness, matchSaved, memoryId, rememberAnswer, savedAnswers } from "../src/core/memory.ts";

test("the same question in other words matches; a different question doesn't", () => {
  assert.equal(likeness("Which language do you prefer for the classes?", "which language do you prefer for the classes"), 1);
  assert.ok(likeness("Which language do you prefer for classes?", "What language would you like the classes in?") >= 0.6);
  assert.ok(likeness("Which language do you prefer for the classes?", "Do you need cleaning supplies provided?") < 0.6);
  assert.equal(memoryId("amy", "Which language?"), memoryId("amy", "which language"), "one note per question");
  assert.notEqual(memoryId("amy", "Which language?"), memoryId("bob", "Which language?"), "and per owner");
});

test("answers are kept Private, updated not duplicated, and reused only when allowed", async () => {
  const db = memoryDocs();
  const f = await rememberAnswer(db, "amy", { question: "Which language do you prefer for the classes?", answer: "English", about: "Guitar lessons" }, 1);
  assert.ok(f);
  assert.equal(f!.tier, "private");
  assert.equal(f!.source, "answer");
  assert.equal(f!.reuse, true, "given again by default");
  await rememberAnswer(db, "amy", { question: "Which language do you prefer for the classes", answer: "English or Hindi" }, 2);
  const saved = await savedAnswers(db, "amy");
  assert.equal(saved.length, 1, "asked again: updated, not added twice");
  assert.equal(saved[0].answer, "English or Hindi");
  assert.equal(saved[0].about, "Guitar lessons", "keeps what it was about");
  assert.equal(matchSaved(saved, "What language would you like the classes in?")?.answer, "English or Hindi");
  assert.equal(matchSaved(saved, "Do you need cleaning supplies provided?"), null);
  assert.equal(matchSaved(saved, "Which language do you prefer for the classes?", true)?.reuse, true);
  await rememberAnswer(db, "amy", { question: "Which language do you prefer for the classes?", answer: "English", reuse: false }, 5);
  assert.equal(matchSaved(await savedAnswers(db, "amy"), "Which language do you prefer for the classes?", true), null, "set to ask first: not given on its own");

  await rememberAnswer(db, "amy", { question: "How can they reach you?", answer: "Call me on 98450 12345", reuse: true }, 3);
  const contact = (await savedAnswers(db, "amy")).find(x => /reach/.test(x.question!));
  assert.ok(contact, "still kept, to fill in for the owner");
  assert.equal(contact?.reuse, false, "contact details are never given out again on the owner's behalf");
  assert.equal(await rememberAnswer(db, "amy", { question: "Which day?", answer: "Not shared." }, 4), null, "a refusal isn't an answer");
  assert.equal((await savedAnswers(db, "bob")).length, 0, "nobody else's");
});
