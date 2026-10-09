import test from "node:test";
import assert from "node:assert/strict";
import { selectSenlerChannels } from "./senler-channel-selection.mjs";

const config = {
  excluded: { disabled: ["common-1"] },
  groups: {
    ege: ["biology-ege", "math-ege"],
    oge: ["biology-oge", "math-oge"],
    common: ["common-1"]
  }
};

test("subject channels are intersected with selected exam buckets", () => {
  assert.deepEqual(
    selectSenlerChannels(config, { pick: "ege", channelIds: ["biology-ege", "biology-oge"] }),
    [{ id: "biology-ege", bucket: "ege" }]
  );
});

test("empty subject selection keeps all non-excluded channels", () => {
  assert.deepEqual(
    selectSenlerChannels(config).map((item) => item.id),
    ["biology-ege", "math-ege", "biology-oge", "math-oge"]
  );
});
