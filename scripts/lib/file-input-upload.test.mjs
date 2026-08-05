import test from "node:test";
import assert from "node:assert/strict";

import { findFileInputByAccept, setFileInputFilesAndDispatch } from "./file-input-upload.mjs";

test("findFileInputByAccept returns the matching file input node metadata", async () => {
  const cdp = async (method, params) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") {
      assert.deepEqual(params, { nodeId: 1, selector: "input[type=file]" });
      return { nodeIds: [10, 20, 30, 40] };
    }
    if (method === "DOM.getAttributes") {
      const attributesByNode = {
        10: ["accept", ".txt", "class", "dz-hidden-input"],
        20: ["accept", "image/*", "id", "image-upload", "class", "dz-hidden-input"],
        30: ["accept", ".ogg", "class", "dz-hidden-input"],
        40: ["accept", "image/png", "id", "fallback-image-upload", "class", "dz-hidden-input"]
      };
      return { attributes: attributesByNode[params.nodeId] };
    }
    throw new Error(`Unexpected CDP method: ${method}`);
  };

  assert.deepEqual(await findFileInputByAccept(cdp, { acceptIncludes: "image" }), {
    nodeId: 40,
    index: 3,
    accept: "image/png",
    id: "fallback-image-upload",
    name: "",
    className: "dz-hidden-input"
  });
});

test("setFileInputFilesAndDispatch dispatches on the resolved node, not a stale input index", async () => {
  const calls = [];
  const cdp = async (method, params) => {
    calls.push({ method, params });
    if (method === "DOM.resolveNode") {
      assert.equal(params.nodeId, 20);
      return { object: { objectId: "object-for-image-input" } };
    }
    if (method === "DOM.setFileInputFiles") {
      assert.deepEqual(params, { nodeId: 20, files: ["C:\\tmp\\image.jpg"] });
      return {};
    }
    if (method === "Runtime.callFunctionOn") {
      assert.equal(params.objectId, "object-for-image-input");
      assert.equal(params.returnByValue, true);
      assert.ok(!params.functionDeclaration.includes("querySelectorAll"));
      return {
        result: {
          value: {
            dispatched: true,
            files: 1,
            accept: "image/*",
            id: "image-upload",
            name: "",
            className: "dz-hidden-input"
          }
        }
      };
    }
    if (method === "Runtime.releaseObject") {
      assert.equal(params.objectId, "object-for-image-input");
      return {};
    }
    throw new Error(`Unexpected CDP method: ${method}`);
  };

  assert.deepEqual(await setFileInputFilesAndDispatch(cdp, { nodeId: 20, filePath: "C:\\tmp\\image.jpg" }), {
    dispatched: true,
    files: 1,
    accept: "image/*",
    id: "image-upload",
    name: "",
    className: "dz-hidden-input"
  });
  assert.deepEqual(calls.map((call) => call.method), [
    "DOM.resolveNode",
    "DOM.setFileInputFiles",
    "Runtime.callFunctionOn",
    "Runtime.releaseObject"
  ]);
});

test("setFileInputFilesAndDispatch fails fast when the input did not receive a file", async () => {
  const cdp = async (method) => {
    if (method === "DOM.resolveNode") return { object: { objectId: "object-for-image-input" } };
    if (method === "DOM.setFileInputFiles") return {};
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: { dispatched: true, files: 0, accept: "image/*" } } };
    }
    if (method === "Runtime.releaseObject") return {};
    throw new Error(`Unexpected CDP method: ${method}`);
  };

  await assert.rejects(
    () => setFileInputFilesAndDispatch(cdp, { nodeId: 20, filePath: "C:\\tmp\\image.jpg" }),
    /did not receive a file/
  );
});
