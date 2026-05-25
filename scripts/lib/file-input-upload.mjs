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

export async function setFileInputFilesAndDispatch(cdp, {
  nodeId,
  filePath,
  normalizeImage = false,
  maxImageSide = 2560,
  maxImageBytes = 4 * 1024 * 1024,
  jpegQuality = 0.86,
  minJpegQuality = 0.72
}) {
  const resolved = await cdp("DOM.resolveNode", { nodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`Unable to resolve file input node ${nodeId}`);

  try {
    await cdp("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    const result = await cdp("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      awaitPromise: true,
      arguments: [
        {
          value: {
            normalizeImage,
            maxImageSide,
            maxImageBytes,
            jpegQuality,
            minJpegQuality
          }
        }
      ],
      functionDeclaration: `async function (options) {
        const details = (file) => file ? {
          name: file.name || "",
          size: file.size || 0,
          type: file.type || ""
        } : null;
        const isImage = (file) => {
          const type = String(file?.type || "").toLowerCase();
          const name = String(file?.name || "");
          return type.startsWith("image/") || /\\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
        };
        const loadImage = (file) => new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Browser could not decode selected image"));
          };
          img.src = url;
        });
        const canvasToBlob = (canvas, quality) => new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("Browser could not encode image as JPEG"));
          }, "image/jpeg", quality);
        });
        const normalizeSelectedImage = async () => {
          const file = this.files?.[0];
          if (!options?.normalizeImage || !file || !isImage(file)) return { skipped: true };

          const image = await loadImage(file);
          const sourceWidth = image.naturalWidth || image.width || 0;
          const sourceHeight = image.naturalHeight || image.height || 0;
          if (!sourceWidth || !sourceHeight) throw new Error("Selected image has no readable dimensions");

          const maxSide = Math.max(320, Number(options.maxImageSide) || 2560);
          const maxBytes = Math.max(512 * 1024, Number(options.maxImageBytes) || 4 * 1024 * 1024);
          const startQuality = Math.min(0.95, Math.max(0.5, Number(options.jpegQuality) || 0.86));
          const minQuality = Math.min(startQuality, Math.max(0.45, Number(options.minJpegQuality) || 0.72));
          const initialScale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
          let width = Math.max(1, Math.round(sourceWidth * initialScale));
          let height = Math.max(1, Math.round(sourceHeight * initialScale));
          let blob = null;
          let quality = startQuality;
          let usedQuality = startQuality;
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Browser canvas is not available");

          for (let resizeAttempt = 0; resizeAttempt < 6; resizeAttempt += 1) {
            canvas.width = width;
            canvas.height = height;
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(image, 0, 0, width, height);

            quality = startQuality;
            while (quality >= minQuality) {
              blob = await canvasToBlob(canvas, quality);
              usedQuality = quality;
              if (blob.size <= maxBytes) break;
              quality -= 0.07;
            }
            if (blob && (blob.size <= maxBytes || Math.max(width, height) <= 1280)) break;
            width = Math.max(1, Math.round(width * 0.85));
            height = Math.max(1, Math.round(height * 0.85));
          }

          const outputName = (String(file.name || "image").replace(/\\.[^.]*$/, "") || "image") + ".jpg";
          const normalizedFile = new File([blob], outputName, { type: "image/jpeg", lastModified: Date.now() });
          const transfer = new DataTransfer();
          transfer.items.add(normalizedFile);
          this.files = transfer.files;
          return {
            normalized: true,
            original: { ...details(file), width: sourceWidth, height: sourceHeight },
            output: { ...details(normalizedFile), width, height, quality: Number(usedQuality.toFixed(2)) },
            maxBytes,
            maxSide
          };
        };

        const normalizedImage = await normalizeSelectedImage();
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          dispatched: true,
          files: this.files?.length || 0,
          accept: this.accept || "",
          id: this.id || "",
          name: this.name || "",
          className: String(this.className || ""),
          file: details(this.files?.[0]),
          normalizedImage
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
