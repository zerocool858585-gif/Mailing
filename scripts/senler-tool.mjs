import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DEFAULT_PORT = 9222;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function chromeJson(pathname, port = DEFAULT_PORT, method = "GET") {
  const url = `http://127.0.0.1:${port}${pathname}`;
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status}`);
  return res.json();
}

async function connectTarget(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  return { target, ws, cdp };
}

async function openOrReuse(groupId, port) {
  const targets = await chromeJson("/json/list", port);
  let target = targets.find((t) => t.type === "page" && t.url.includes(`/cabinet/delivs/${groupId}`));
  if (!target) {
    target = await chromeJson(`/json/new?${encodeURIComponent(`https://senler.ru/cabinet/delivs/${groupId}`)}`, port, "PUT");
  }
  const tab = await connectTarget(target);
  await tab.cdp("Page.bringToFront");
  return tab;
}

function selectedGroups(groups, pick = "all") {
  const chunks = [];
  const keys = pick === "all" ? ["ege", "oge", "common"] : pick.split(",").map((x) => x.trim());
  for (const key of keys) {
    if (!groups.groups[key]) throw new Error(`Unknown group bucket: ${key}`);
    chunks.push(...groups.groups[key].map((id) => ({ id, bucket: key })));
  }
  return chunks;
}

async function evalJson(cdp, expression) {
  const res = await cdp("Runtime.evaluate", { expression, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "Runtime.evaluate failed");
  return res.result.value;
}

async function waitFor(cdp, expression, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalJson(cdp, expression)) return;
    await sleep(300);
  }
  throw new Error(`Timeout: ${expression.slice(0, 100)}`);
}

async function openWaiting(cdp, groupId) {
  await evalJson(cdp, `location.href = "https://senler.ru/cabinet/delivs/${groupId}#status=waiting"; true`);
  await sleep(2500);
  await evalJson(
    cdp,
    `(() => {
      const tab = [...document.querySelectorAll("a,button,div")]
        .find(el => /^Ожидание/.test((el.innerText || "").trim()) && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      if (tab) tab.click();
      return true;
    })()`
  );
  await sleep(900);
}

async function filterWaitingByDate(cdp, campaign) {
  const day = campaign.sendDate.slice(0, 10);
  await evalJson(
    cdp,
    `(() => {
      const collapse = document.querySelector("#collapseSearch");
      if (collapse) {
        collapse.classList.add("show");
        collapse.style.display = "block";
      }
      const set = (name, val) => {
        const el = document.querySelector('#collapseSearch [name="' + name + '"], [name="' + name + '"]');
        if (!el) return null;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value;
      };
      set("search", "");
      set("date_from", ${JSON.stringify(day)});
      set("date_to", ${JSON.stringify(day)});
      const show = [...document.querySelectorAll("#collapseSearch a,#collapseSearch button,#collapseSearch div,.submit")]
        .find(el => (el.innerText || "").trim() === "Показать");
      if (show) show.click();
      return true;
    })()`
  );
  await sleep(2500);
}

async function clickShowMoreUntilFound(cdp, campaign, maxClicks = 8) {
  let clicked = 0;
  for (let i = 0; i < maxClicks; i += 1) {
    if (await evalJson(cdp, `document.body.innerText.includes(${JSON.stringify(campaign.name)})`)) break;
    const didClick = await evalJson(
      cdp,
      `(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const more = [...document.querySelectorAll("a,button,div")]
          .find(el => (el.innerText || "").trim() === "Показать еще" && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        if (more) more.click();
        return !!more;
      })()`
    );
    if (!didClick) break;
    clicked += 1;
    await sleep(1400);
  }
  return clicked;
}

async function openCard(cdp, campaign) {
  const result = await evalJson(
    cdp,
    `(() => {
      const title = ${JSON.stringify(campaign.name)};
      const cards = [...document.querySelectorAll(".deliv-item,.collapse-card-info,.card,.d-flex.justify-content-between,.list-infinite-delivs > *")]
        .filter(el => (el.innerText || "").includes(title));
      const card = cards[0];
      if (!card) return { found: false, text: document.body.innerText.slice(0, 1200) };
      card.scrollIntoView({ block: "center" });
      const clickable = card.querySelector(".tlt-infinite-delivs,.card-header,.btn.btn-block,.btn,[data-toggle='collapse']") || card;
      clickable.click();
      return { found: true, text: card.innerText.trim().replace(/\\s+/g, " ").slice(0, 1000) };
    })()`
  );
  await sleep(900);
  await evalJson(
    cdp,
    `(() => {
      const title = ${JSON.stringify(campaign.name)};
      const card = [...document.querySelectorAll(".deliv-item,.collapse-card-info,.card,.d-flex.justify-content-between,.list-infinite-delivs > *")]
        .find(el => (el.innerText || "").includes(title));
      const more = card ? [...card.querySelectorAll("a,button,div")]
        .find(el => (el.innerText || "").trim() === "Показать еще" && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) : null;
      if (more) more.click();
      return !!more;
    })()`
  );
  await sleep(700);
  return result;
}

async function validateGroup(cdp, groupId, campaign) {
  await openWaiting(cdp, groupId);
  await filterWaitingByDate(cdp, campaign);
  const clickedMore = await clickShowMoreUntilFound(cdp, campaign);
  const opened = await openCard(cdp, campaign);
  const details = await evalJson(
    cdp,
    `(() => {
      const campaign = ${JSON.stringify(campaign)};
      const txt = document.body.innerText;
      const html = document.body.innerHTML;
      const title = campaign.name;
      const idx = txt.indexOf(title);
      const frag = idx >= 0 ? txt.slice(idx, idx + 4000) : txt.slice(0, 1800);
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const normalizedFrag = normalize(frag);
      const expectedParts = String(campaign.message || "")
        .split(/\\r?\\n/)
        .map(part => normalize(part))
        .filter(part => part.length >= 6)
        .slice(0, 4);
      const expectsFormatting = !!((campaign.formats || []).length || (campaign.boldPhrases || []).length);
      return {
        found: idx >= 0,
        active: frag.includes("Активировано:"),
        sendDate: txt.includes(campaign.sendDate),
        textOk: expectedParts.length ? expectedParts.every(part => normalizedFrag.includes(part)) : true,
        formattedOk: expectsFormatting ? /<(strong|em|u|a)\\b/.test(html) : true,
        noFilterWarning: txt.includes("Не используются фильтры"),
        recipients: (frag.match(/Получатели:\\s*\\d+/) || [""])[0],
        fragment: frag.slice(0, 700)
      };
    })()`
  );
  return {
    ok: opened.found && details.found && details.active && details.sendDate && details.textOk && details.formattedOk && !details.noFilterWarning,
    clickedMore,
    opened,
    details,
  };
}

async function fillEditor(cdp, campaign) {
  const result = await evalJson(
    cdp,
    `(() => {
      const campaign = ${JSON.stringify(campaign)};
      const setVal = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.focus?.();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value;
      };
      setVal('input[name="name"]', campaign.name);
      setVal('input[name="send_date"]', campaign.sendDate);
      const editor = document.querySelector(".ql-editor:not(.ghost-highlight-area)") || document.querySelector(".ql-editor");
      const container = editor?.closest(".ql-container") || document.querySelector(".ql-container");
      const quill = window.Quill && container ? window.Quill.find(container) : null;
      if (quill) {
        quill.setText(campaign.message, "user");
        for (const fmt of campaign.formats || []) {
          const offset = Number(fmt.offset) || 0;
          const length = Number(fmt.length) || 0;
          if (length <= 0) continue;
          const attrs = {};
          if (fmt.bold) attrs.bold = true;
          if (fmt.italic) attrs.italic = true;
          if (fmt.underline) attrs.underline = true;
          if (fmt.link) attrs.link = String(fmt.link);
          if (Object.keys(attrs).length) quill.formatText(offset, length, attrs, "user");
        }
        for (const phrase of campaign.boldPhrases || []) {
          const idx = campaign.message.indexOf(phrase);
          if (idx >= 0) quill.formatText(idx, phrase.length, { bold: true }, "user");
        }
        quill.update("user");
        editor?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: campaign.message }));
        editor?.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (editor) {
        editor.textContent = campaign.message;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: campaign.message }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const hidden = (name, val) => {
        const el = document.querySelector('input[name="' + name + '"]');
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      hidden("message", campaign.message);
      hidden("format_data", editor ? editor.innerHTML : campaign.message);
      const deltaOps = quill ? quill.getContents().ops : [];
      hidden("quill_delta", quill ? JSON.stringify({ ops: deltaOps }) : "");
      const text = quill ? quill.getText() : (editor?.innerText || "");
      const hasFormattedDelta = deltaOps.some(op => op.attributes && Object.keys(op.attributes).length);
      const html = editor?.innerHTML || "";
      return {
        title: document.querySelector('input[name="name"]')?.value || "",
        sendDate: document.querySelector('input[name="send_date"]')?.value || "",
        textLength: text.length,
        expectedMessageLength: String(campaign.message || "").length,
        hiddenMessageLength: document.querySelector('input[name="message"]')?.value?.length || 0,
        editorCount: document.querySelectorAll(".ql-editor").length,
        hasQuill: !!window.Quill,
        bold: html.includes("<strong>") || deltaOps.some(op => op.attributes?.bold),
        formatted: hasFormattedDelta || /<(strong|b|em|i|u|a)\b|font-weight:\\s*(bold|[6-9]00)|text-decoration[^;]*underline/i.test(html)
      };
    })()`
  );
  const expectsFormatting = (campaign.formats || []).length || (campaign.boldPhrases || []).length;
  const expectedMessageLength = String(campaign.message || "").length;
  const textFilled = expectedMessageLength > 0
    && result.hiddenMessageLength === expectedMessageLength
    && result.textLength >= expectedMessageLength;
  if (!textFilled || (expectsFormatting && !result.formatted)) throw new Error(`Editor fill failed: ${JSON.stringify(result)}`);
  return result;
}

async function addDateFilter(cdp, campaign) {
  await evalJson(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll(".SubscriberFilter .btn,.SubscriberFilter,a,button,div")]
        .find(el => (el.innerText || "").trim() === "Добавить фильтр" && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      if (btn) btn.click();
      return !!btn;
    })()`
  );
  await sleep(500);
  await evalJson(
    cdp,
    `(() => {
      const items = [...document.querySelectorAll(".SubscriberFilter .dropdown-item,.dropdown-menu .dropdown-item,a,div")]
        .filter(el => (el.innerText || "").trim() === "Дата подписки");
      const item = items.find(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !String(el.className || "").includes("disabled"))
        || items.find(el => !String(el.className || "").includes("disabled"))
        || items[0];
      if (item) item.click();
      return !!item;
    })()`
  );
  await sleep(900);
  return evalJson(
    cdp,
    `(() => {
      const set = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value;
      };
      return {
        from: set('input[name="filter[date_subscription_from]"]', ${JSON.stringify(campaign.subscriptionFrom)}),
        to: set('input[name="filter[date_subscription_to]"]', "")
      };
    })()`
  );
}

async function attachImage(cdp, campaign) {
  if (!campaign.imagePath) return { skipped: true };
  await fs.access(campaign.imagePath);
  const before = await evalJson(cdp, `document.querySelectorAll(".message_attachments .attachment_item").length`);
  const doc = await cdp("DOM.getDocument", {});
  const all = await cdp("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
  let imageNode = null;
  let imageIndex = -1;
  let imageInput = null;
  const nodeIds = all.nodeIds || [];
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index];
    const attrs = await cdp("DOM.getAttributes", { nodeId });
    const pairs = attrs.attributes || [];
    const map = Object.fromEntries(Array.from({ length: Math.floor(pairs.length / 2) }, (_, i) => [pairs[i * 2], pairs[i * 2 + 1]]));
    if ((map.accept || "").includes("image")) {
      imageNode = nodeId;
      imageIndex = index;
      imageInput = {
        index,
        accept: map.accept || "",
        id: map.id || "",
        name: map.name || "",
        className: map.class || ""
      };
    }
  }
  if (!imageNode) {
    const inputs = await evalJson(
      cdp,
      `(() => [...document.querySelectorAll("input[type=file]")].map((el, index) => ({
        index,
        accept: el.accept || "",
        id: el.id || "",
        name: el.name || "",
        className: String(el.className || "")
      })))()`
    );
    throw new Error(`Image file input not found: ${JSON.stringify(inputs)}`);
  }
  await cdp("DOM.setFileInputFiles", { nodeId: imageNode, files: [campaign.imagePath] });
  const dispatch = await evalJson(
    cdp,
    `(() => {
      const input = [...document.querySelectorAll("input[type=file]")][${imageIndex}];
      if (!input) return { dispatched: false, reason: "input_not_found" };
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        dispatched: true,
        files: input.files?.length || 0,
        accept: input.accept || "",
        id: input.id || "",
        name: input.name || "",
        className: String(input.className || "")
      };
    })()`
  );
  try {
    await waitFor(cdp, `document.querySelectorAll(".message_attachments .attachment_item").length > ${before}`, 90000);
  } catch (error) {
    const diagnostics = await evalJson(
      cdp,
      `(() => ({
        url: location.href,
        readyState: document.readyState,
        before: ${before},
        after: document.querySelectorAll(".message_attachments .attachment_item").length,
        fileInputs: [...document.querySelectorAll("input[type=file]")].map((el, index) => ({
          index,
          accept: el.accept || "",
          id: el.id || "",
          name: el.name || "",
          className: String(el.className || ""),
          files: el.files?.length || 0,
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
        })),
        attachmentsHtml: (document.querySelector(".message_attachments")?.innerHTML || "").slice(0, 1000),
        uploadText: [...document.querySelectorAll(".message_attachments,.attachment_item,.file_upload,.progress,.alert,.toast,.error,.help-block")]
          .map(el => (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " "))
          .filter(Boolean)
          .slice(0, 20)
      }))()`
    );
    throw new Error(`Image attach failed: ${error.message}; ${JSON.stringify({ imageInput, dispatch, diagnostics })}`);
  }
  const after = await evalJson(cdp, `document.querySelectorAll(".message_attachments .attachment_item").length`);
  return { imageInput: true, before, after, attached: after > before };
}

async function activateFromModal(cdp) {
  return evalJson(
    cdp,
    `(() => {
      const modal = [...document.querySelectorAll(".modal.show,.modal")]
        .find(m => (m.innerText || "").includes("Рассылка сохранена"));
      const btn = modal?.querySelector(".btn.btn-success.submit");
      if (btn) btn.click();
      return { modal: !!modal, clicked: !!btn, text: modal?.innerText.trim().replace(/\\s+/g, " ").slice(0, 300) || "" };
    })()`
  );
}

async function createGroup(cdp, groupId, campaign, shouldActivate) {
  await evalJson(cdp, `location.href = "https://senler.ru/cabinet/delivs/${groupId}"; true`);
  await waitFor(cdp, `document.readyState === "complete" && document.body.innerText.includes("Новая рассылка")`, 25000);
  await evalJson(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll("a,button")].find(x => (x.innerText || "").includes("Новая рассылка"));
      if (el) el.click();
      return !!el;
    })()`
  );
  await waitFor(cdp, `document.body.innerText.includes("Создание рассылки") && document.body.innerText.includes("Разовая рассылка")`, 12000);
  await evalJson(
    cdp,
    `(() => {
      const modal = document.querySelector(".modal.show");
      const label = [...modal.querySelectorAll("label")].find(l => l.innerText.includes("Разовая рассылка"));
      if (label) label.click();
      const btn = [...modal.querySelectorAll("button,.btn,a,div")].find(el => (el.innerText || "").trim() === "Продолжить");
      if (btn) btn.click();
      return { label: !!label, btn: !!btn };
    })()`
  );
  await waitFor(cdp, `location.href.includes("/cabinet/edit_deliv/") && !!document.querySelector('input[name="name"]')`, 25000);
  await waitFor(cdp, `!!document.querySelector(".ql-editor") && !!window.Quill`, 30000);
  const fields = await fillEditor(cdp, campaign);
  const filter = await addDateFilter(cdp, campaign);
  const image = await attachImage(cdp, campaign);
  const saved = await evalJson(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll("a,button,input,div")]
        .find(el => (el.innerText || el.value || "").trim() === "Сохранить" && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      if (btn) btn.click();
      return !!btn;
    })()`
  );
  await sleep(5000);
  const activation = shouldActivate ? await activateFromModal(cdp) : { skipped: true };
  await sleep(3500);
  return { fields, filter, image, saved, activation };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  const port = Number(args.port || DEFAULT_PORT);
  const groupsPath = path.resolve(ROOT, args.groups || "senler/groups.json");
  const campaignPath = path.resolve(ROOT, args.campaign || "senler/campaign.example.json");
  const groups = await readJson(groupsPath);
  const campaign = await readJson(campaignPath);
  const selected = selectedGroups(groups, args.only || "all").filter((g) => !Object.values(groups.excluded || {}).flat().includes(g.id));

  if (command === "help") {
    console.log(`Usage:
  npm run senler -- open-tabs [--only ege,oge,common]
  npm run senler -- validate [--only ege]
  npm run senler -- run --confirm-send [--only oge]

Before use, start Chrome with:
  chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\Users\\sheld\\Documents\\Codex\\chrome-senler" https://senler.ru/
`);
    return;
  }

  if (command === "open-tabs") {
    for (const group of selected) {
      await chromeJson(`/json/new?${encodeURIComponent(`https://senler.ru/cabinet/delivs/${group.id}`)}`, port, "PUT");
      console.log(`[open] ${group.bucket} ${group.id}`);
      await sleep(300);
    }
    return;
  }

  if (command === "validate" || command === "run") {
    const createMissing = command === "run";
    const shouldActivate = Boolean(args["confirm-send"]);
    if (createMissing && !shouldActivate) {
      throw new Error("Refusing to create/activate without --confirm-send");
    }
    for (const group of selected) {
      const tab = await openOrReuse(group.id, port);
      let validation = await validateGroup(tab.cdp, group.id, campaign);
      if (!validation.ok && createMissing) {
        console.log(`[create] ${group.bucket} ${group.id}`);
        const created = await createGroup(tab.cdp, group.id, campaign, shouldActivate);
        validation = await validateGroup(tab.cdp, group.id, campaign);
        console.log(JSON.stringify({ group: group.id, created, validation: validation.details }, null, 2));
      } else {
        console.log(JSON.stringify({ group: group.id, bucket: group.bucket, ok: validation.ok, validation: validation.details }, null, 2));
      }
      await sleep(500);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
