function attrsToMap(attributes = []) {
  return Object.fromEntries(
    Array.from({ length: Math.floor(attributes.length / 2) }, (_, index) => [
      attributes[index * 2],
      attributes[index * 2 + 1]
    ])
  );
}

export async function findFileInputByAccept(cdp, { acceptIncludes } = {}) {
  const doc = await cdp("DOM.getDocument", {});
  const all = await cdp("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
  const needle = String(acceptIncludes || "").toLowerCase();
  const nodeIds = all.nodeIds || [];
  let matched = null;

  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index];
    const attrs = await cdp("DOM.getAttributes", { nodeId });
    const map = attrsToMap(attrs.attributes || []);
    const accept = String(map.accept || "");
    if (!accept.toLowerCase().includes(needle)) continue;

    matched = {
      nodeId,
      index,
      accept,
      id: map.id || "",
      name: map.name || "",
      className: map.class || ""
    };
  }

  return matched;
}

export async function setFileInputFilesAndDispatch(cdp, { nodeId, filePath }) {
  const resolved = await cdp("DOM.resolveNode", { nodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`Unable to resolve file input node ${nodeId}`);

  try {
    await cdp("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    const result = await cdp("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          dispatched: true,
          files: this.files?.length || 0,
          accept: this.accept || "",
          id: this.id || "",
          name: this.name || "",
          className: String(this.className || "")
        };
      }`
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.callFunctionOn failed");
    }
    const dispatch = result.result?.value;
    if (!dispatch?.files) {
      throw new Error(`File input did not receive a file after DOM.setFileInputFiles for node ${nodeId}`);
    }
    return dispatch;
  } finally {
    await cdp("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}
