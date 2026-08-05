import test from "node:test";
import assert from "node:assert/strict";
import { escapeMarkdownV2, escapeMarkdownV2Code, escapeMarkdownV2Url } from "./markdown-v2.mjs";

test("escapeMarkdownV2 escapes Telegram MarkdownV2 special characters", () => {
  assert.equal(
    escapeMarkdownV2("a_b *x* [t](u) ~ ` > # + - = | { } . ! \\"),
    "a\\_b \\*x\\* \\[t\\]\\(u\\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\"
  );
});

test("escapeMarkdownV2 preserves literal backslashes before punctuation", () => {
  assert.equal(escapeMarkdownV2("C:\\.config x\\\\!"), "C:\\\\\\.config x\\\\\\\\\\!");
});

test("escape helpers preserve non-null falsy values", () => {
  assert.equal(escapeMarkdownV2(0), "0");
  assert.equal(escapeMarkdownV2Code(false), "false");
  assert.equal(escapeMarkdownV2Url(0), "0");
});

test("escapeMarkdownV2Code escapes backticks and backslashes only", () => {
  assert.equal(escapeMarkdownV2Code("const x = `a\\b`;"), "const x = \\`a\\\\b\\`;");
});

test("escapeMarkdownV2Url escapes link destination delimiters", () => {
  assert.equal(escapeMarkdownV2Url("https://example.com/a)b\\c"), "https://example.com/a\\)b\\\\c");
});
