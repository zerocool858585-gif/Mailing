import test from "node:test";
import assert from "node:assert/strict";
import { buildSaleBotButtons } from "./salebot-buttons.mjs";

test("buildSaleBotButtons converts multiple campaign buttons to SaleBot inline buttons", () => {
  assert.deepEqual(
    buildSaleBotButtons({
      buttons: [
        { text: "ОТКРЫТЬ", url: "https://example.com/one" },
        { text: "ПОДРОБНЕЕ", url: "https://example.com/two" },
      ],
    }),
    [
      {
        line: 0,
        index_in_line: 0,
        text: "ОТКРЫТЬ",
        type: "inline",
        url: "https://example.com/one",
        callback_link: false,
      },
      {
        line: 1,
        index_in_line: 0,
        text: "ПОДРОБНЕЕ",
        type: "inline",
        url: "https://example.com/two",
        callback_link: false,
      },
    ]
  );
});

test("buildSaleBotButtons keeps legacy buttonText and buttonUrl campaigns working", () => {
  assert.deepEqual(
    buildSaleBotButtons({
      buttonText: "ОТКРЫТЬ",
      buttonUrl: "https://example.com/legacy",
    }),
    [
      {
        line: 0,
        index_in_line: 0,
        text: "ОТКРЫТЬ",
        type: "inline",
        url: "https://example.com/legacy",
        callback_link: false,
      },
    ]
  );
});
