import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { findFileInputByAccept, setFileInputFilesAndDispatch } from "./lib/file-input-upload.mjs";
import { PROJECT_ROOT as ROOT, resolveProjectPath } from "./lib/project-paths.mjs";
import { selectSenlerChannels } from "./lib/senler-channel-selection.mjs";

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
  let closed = false;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const rejectPending = (error) => {
    closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  ws.on("close", () => rejectPending(new Error(`Chrome DevTools connection closed for ${target.url || target.id || "target"}`)));
  ws.on("error", (error) => rejectPending(error));
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`Chrome DevTools connection is closed before ${method}`));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
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

function imageUploadDiagnosticsExpression(before) {
  return `(() => {
    const uploadText = [...document.querySelectorAll(".message_attachments,.attachment_item,.file_upload,.progress,.alert,.toast,.error,.help-block,.invalid-feedback,.text-danger")]
      .map(el => (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " "))
      .filter(Boolean)
      .slice(0, 30);
    const uploadError = uploadText.find(text => /ошибка|не загружен|failed|error/i.test(text)) || "";
    return {
      url: location.href,
      readyState: document.readyState,
      before: ${before},
      after: document.querySelectorAll(".message_attachments .attachment_item").length,
      uploadError,
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
      uploadText
    };
  })()`;
}

async function waitForImageAttachment(cdp, before, timeout = 120000) {
  const start = Date.now();
  let diagnostics = null;
  while (Date.now() - start < timeout) {
    diagnostics = await evalJson(cdp, imageUploadDiagnosticsExpression(before));
    if (diagnostics.after > before) return diagnostics;
    if (diagnostics.uploadError) {
      throw new Error(`Senler/VK rejected image upload: ${diagnostics.uploadError}`);
    }
    await sleep(500);
  }
  throw new Error(`Timeout: document.querySelectorAll(".message_attachments .attachment_item").length > ${before}; ${JSON.stringify(diagnostics)}`);
}

async function clearUploadNotices(cdp) {
  await evalJson(
    cdp,
    `(() => {
      for (const el of document.querySelectorAll(".alert .close,.alert [data-dismiss='alert'],.toast .close,.toast [data-dismiss='toast']")) {
        el.click();
      }
      for (const el of document.querySelectorAll(".alert,.toast,.error,.help-block,.invalid-feedback,.text-danger")) {
        const text = (el.innerText || el.textContent || "").trim();
        if (/ошибка|не загружен|failed|error/i.test(text)) el.remove();
      }
      return true;
    })()`
  ).catch(() => {});
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
        editor?.dispatchEvent(new Event("change", { bubbles: true }));
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

async function waitForRecipientCount(cdp, timeoutMs = 10000) {
  await sleep(1200);
  const startedAt = Date.now();
  let previous = null;
  let stableReads = 0;
  let lastResult = { found: false, count: null, matches: [] };

  while (Date.now() - startedAt < timeoutMs) {
    lastResult = await evalJson(
      cdp,
      `(() => {
        const text = document.body.innerText || "";
        const matches = [...text.matchAll(/(?:Получатели|Получателей|Подписчики|Подписчиков)\\s*:?\\s*([\\d \\u00a0]+)/gi)]
          .map(match => ({
            label: match[0].replace(/\\s+/g, " ").trim(),
            count: Number(match[1].replace(/[ \\u00a0]/g, ""))
          }))
          .filter(item => Number.isFinite(item.count));
        const preferred = matches.find(item => /^Получател/i.test(item.label)) || matches[0] || null;
        return {
          found: !!preferred,
          count: preferred?.count ?? null,
          matches: matches.slice(0, 20)
        };
      })()`
    );

    if (lastResult.found) {
      if (lastResult.count === previous) stableReads += 1;
      else stableReads = 1;
      previous = lastResult.count;
      if (stableReads >= 3) return lastResult;
    }
    await sleep(400);
  }

  return lastResult;
}

async function removeDateFilter(cdp) {
  const cleared = await evalJson(
    cdp,
    `(() => {
      const inputs = [
        document.querySelector('input[name="filter[date_subscription_from]"]'),
        document.querySelector('input[name="filter[date_subscription_to]"]')
      ].filter(Boolean);
      for (const input of inputs) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { cleared: inputs.length > 0, inputs: inputs.length };
    })()`
  );
  await sleep(300);

  const removed = await evalJson(
    cdp,
    `(() => {
      const input = document.querySelector('input[name="filter[date_subscription_from]"]')
        || document.querySelector('input[name="filter[date_subscription_to]"]');
      const container = input?.closest('.form-group.card,.card,.filter-item,.SubscriberFilter > div');
      if (!container) return { clicked: false, reason: "date filter container not found" };
      const controls = [...container.querySelectorAll('button,a,[role="button"],.close,[class*="remove"],[class*="delete"]')];
      const describe = el => [
        el.innerText,
        el.textContent,
        el.title,
        el.getAttribute("aria-label"),
        el.className
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const control = controls.find(el => /удал|убрать|remove|delete|trash|close|times/i.test(describe(el)))
        || controls.find(el => /^[×✕]$/.test((el.innerText || el.textContent || "").trim()));
      if (control) control.click();
      return { clicked: !!control, control: control ? describe(control).slice(0, 200) : "" };
    })()`
  );

  await sleep(900);
  return { ...cleared, ...removed };
}

async function removeDateFilterWhenAudienceIsEmpty(cdp) {
  const before = await waitForRecipientCount(cdp);
  if (!before.found || before.count !== 0) {
    return { removed: false, before, reason: before.found ? "recipient count is not zero" : "recipient count not found" };
  }

  const removal = await removeDateFilter(cdp);
  const after = await waitForRecipientCount(cdp);
  console.warn(
    `[warning] Subscription date filter produced 0 recipients; filter removed. `
      + `Recipients after fallback: ${after.found ? after.count : "unknown"}`
  );
  return { removed: true, before, removal, after };
}

// Общая логика для двух фильтров Senler по группам подписчиков: "Группа подписчиков" (включение)
// и "За исключением группы" (исключение). Оба используют одинаковый select2-виджет,
// отличаются только name у <select> и data-value у пункта меню "Добавить фильтр".
async function applySubscriberGroupFilter(cdp, { groupId, requestedGroups, selectName, dropdownValue, filterLabel }) {
  if (!requestedGroups.length) {
    return { skipped: true, reason: "no groups specified" };
  }

  const selectSelector = `select[name="${selectName}"]`;

  const filterVisible = await evalJson(
    cdp,
    `(() => {
      const select = document.querySelector(${JSON.stringify(selectSelector)});
      const container = select?.closest('.form-group.card');
      return !!select && !!container && !!(container.offsetWidth || container.offsetHeight || container.getClientRects().length);
    })()`
  );

  if (!filterVisible) {
    const addFilterClicked = await evalJson(
      cdp,
      `(() => {
        const btn = [...document.querySelectorAll(".SubscriberFilter .btn,.SubscriberFilter,a,button,div")]
          .find(el => (el.innerText || "").trim() === "Добавить фильтр" && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        if (btn) btn.click();
        return !!btn;
      })()`
    );
    if (!addFilterClicked) {
      throw new Error(`Subscriber filter button not found for channel ${groupId}`);
    }

    const visibleItemExpression = `(() => {
      const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const item = document.querySelector('.SubscriberFilter .dropdown-menu .dropdown-item[data-value="${dropdownValue}"]');
      const menu = item?.closest(".dropdown-menu");
      return !!item
        && !!menu
        && isVisible(menu)
        && isVisible(item)
        && !String(item.className || "").includes("disabled")
        && item.getAttribute("aria-disabled") !== "true";
    })()`;
    try {
      await waitFor(cdp, visibleItemExpression, 10000);
    } catch {
      throw new Error(`Visible "${filterLabel}" filter option did not appear for channel ${groupId}`);
    }

    const itemClicked = await evalJson(
      cdp,
      `(() => {
        const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const item = document.querySelector('.SubscriberFilter .dropdown-menu .dropdown-item[data-value="${dropdownValue}"]');
        const menu = item?.closest(".dropdown-menu");
        const clickable = !!item
          && !!menu
          && isVisible(menu)
          && isVisible(item)
          && !String(item.className || "").includes("disabled")
          && item.getAttribute("aria-disabled") !== "true";
        if (clickable) item.click();
        return clickable;
      })()`
    );
    if (!itemClicked) {
      throw new Error(`Visible "${filterLabel}" filter option not found for channel ${groupId}`);
    }
  }

  try {
    await waitFor(
      cdp,
      `(() => {
        const select = document.querySelector(${JSON.stringify(selectSelector)});
        const container = select?.closest('.form-group.card');
        return !!select && !!container && !!(container.offsetWidth || container.offsetHeight || container.getClientRects().length);
      })()`,
      25000
    );
  } catch {
    const diagnostics = await evalJson(
      cdp,
      `(() => {
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const describe = (el, index) => ({
          index,
          tag: el.tagName,
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          role: el.getAttribute("role") || "",
          className: String(el.className || ""),
          visible: visible(el),
          text: (el.innerText || el.textContent || el.value || "").trim().replace(/\\s+/g, " ").slice(0, 300)
        });
        const filter = document.querySelector(".SubscriberFilter");
        return {
          url: location.href,
          filterText: (filter?.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 2000),
          filterHtml: (filter?.outerHTML || "").slice(0, 12000),
          filterControls: [...(filter?.querySelectorAll("select,input,textarea,button,[role]") || [])].map(describe),
          visibleGroupItems: [...document.querySelectorAll("a,button,div,li,[role=option],[role=menuitem]")]
            .filter(el => visible(el) && /групп/i.test((el.innerText || el.textContent || "").trim()))
            .slice(0, 30)
            .map(describe),
          allSelects: [...document.querySelectorAll("select")].map(describe)
        };
      })()`
    );
    throw new Error(
      `"${filterLabel}" filter control did not appear for channel ${groupId}: ${JSON.stringify(diagnostics)}`
    );
  }

  for (const requested of requestedGroups) {
    const classQuery = requested.match(/\d+\s*класс(?:\s+или\s+младше)?/i)?.[0];
    const searchQuery = classQuery
      || requested.split(/[‐‑‒–—―−-]/).map((part) => part.trim()).filter(Boolean).at(-1)
      || requested;
    const alreadySelected = await evalJson(
      cdp,
      `(() => {
        const requested = ${JSON.stringify(requested)};
        const normalize = value => String(value || "")
          .replace(/[‐‑‒–—―−-]+/g, " ")
          .replace(/\\s+/g, " ")
          .trim()
          .toLowerCase();
        const select = document.querySelector(${JSON.stringify(selectSelector)});
        return [...(select?.selectedOptions || [])].some(option =>
          String(option.value) === requested || normalize(option.text).includes(normalize(requested))
        );
      })()`
    );
    if (alreadySelected) continue;

    const searchOpened = await evalJson(
      cdp,
      `(() => {
        const select = document.querySelector(${JSON.stringify(selectSelector)});
        const selection = select?.parentElement?.querySelector('.select2-selection');
        if (selection) selection.click();
        return !!selection;
      })()`
    );
    if (!searchOpened) {
      throw new Error(`"${filterLabel}" search did not open for channel ${groupId}`);
    }
    await waitFor(
      cdp,
      `(() => {
        const select = document.querySelector(${JSON.stringify(selectSelector)});
        const input = select?.parentElement?.querySelector('.select2-search__field');
        return !!input && !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length);
      })()`,
      5000
    );
    await evalJson(
      cdp,
      `(() => {
        const select = document.querySelector(${JSON.stringify(selectSelector)});
        const input = select?.parentElement?.querySelector('.select2-search__field');
        if (!input) return false;
        input.value = ${JSON.stringify(searchQuery)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
        return true;
      })()`
    );
    const matchingResultExpression = `(() => {
      const requested = ${JSON.stringify(requested)};
      const normalize = value => String(value || "")
        .replace(/[‐‑‒–—―−-]+/g, " ")
        .replace(/\\s+/g, " ")
        .trim()
        .toLowerCase();
      return [...document.querySelectorAll('.select2-results__option')].some(option =>
        !!(option.offsetWidth || option.offsetHeight || option.getClientRects().length)
        && normalize(option.innerText || option.textContent).includes(normalize(requested))
      );
    })()`;
    try {
      await waitFor(cdp, matchingResultExpression, 10000);
      await evalJson(
        cdp,
        `(() => {
          const requested = ${JSON.stringify(requested)};
          const normalize = value => String(value || "")
            .replace(/[‐‑‒–—―−-]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim()
            .toLowerCase();
          const visibleOptions = [...document.querySelectorAll('.select2-results__option')]
            .filter(item => !!(item.offsetWidth || item.offsetHeight || item.getClientRects().length));
          const option = visibleOptions.find(item =>
            normalize(item.innerText || item.textContent) === normalize(requested)
          ) || visibleOptions.find(item =>
            normalize(item.innerText || item.textContent).includes(normalize(requested))
          );
          if (option) {
            option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
          return !!option;
        })()`
      );
      await sleep(300);
    } catch {
      await evalJson(cdp, `document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); true`).catch(() => {});
    }
  }

  const selection = await evalJson(
    cdp,
    `(() => {
      const requestedGroups = ${JSON.stringify(requestedGroups)};
      const normalize = value => String(value || "")
        .replace(/[‐‑‒–—―−-]+/g, " ")
        .replace(/\\s+/g, " ")
        .trim()
        .toLowerCase();
      const select = document.querySelector(${JSON.stringify(selectSelector)});
      if (!select) return { ok: false, error: ${JSON.stringify(`"${filterLabel}" select not found`)}, selectedGroups: [] };
      const selectedOptions = [...select.selectedOptions];
      const selectedGroups = requestedGroups.flatMap(requested => {
        const option = selectedOptions.find(item =>
          String(item.value) === requested || normalize(item.text).includes(normalize(requested))
        );
        return option ? [{ requested, id: String(option.value), text: option.text.trim() }] : [];
      });
      return { ok: true, selectedGroups };
    })()`
  );

  if (!selection.ok) throw new Error(`${selection.error} for channel ${groupId}`);
  if (!selection.selectedGroups.length) {
    return {
      ok: false,
      noMatch: true,
      selectedGroups: [],
      ignoredGroups: requestedGroups,
      reason: `None of the requested "${filterLabel}" groups exist in channel ${groupId}. Requested: ${requestedGroups.join("; ")}`,
    };
  }

  await sleep(300);
  const verifiedGroupIds = await evalJson(
    cdp,
    `(() => {
      const select = document.querySelector(${JSON.stringify(selectSelector)});
      if (!select) return [];
      return [...select.selectedOptions].map(option => String(option.value)).filter(Boolean);
    })()`
  );
  const matchedGroupIds = selection.selectedGroups.map((group) => group.id);
  const missingAfterChange = matchedGroupIds.filter((id) => !verifiedGroupIds.includes(id));
  if (missingAfterChange.length) {
    throw new Error(
      `Senler did not retain "${filterLabel}" selection for channel ${groupId}: ${missingAfterChange.join(", ")}`
    );
  }

  return {
    ok: true,
    selectedGroups: selection.selectedGroups,
    ignoredGroups: requestedGroups.filter(
      (requested) => !selection.selectedGroups.some((group) => group.requested === requested)
    ),
  };
}

async function addGroupFilter(cdp, campaign, groupId) {
  const requestedGroups = [...new Set((campaign.subscriberGroups || []).map((value) => String(value).trim()).filter(Boolean))];
  return applySubscriberGroupFilter(cdp, {
    groupId,
    requestedGroups,
    selectName: "filter[subscription_id][]",
    dropdownValue: "subscription_id",
    filterLabel: "Группа подписчиков",
  });
}

// Фильтр Senler "За исключением группы": использует отдельный select
// filter[ignore_subscription_id][] (вывод из id select2-виджета в DOM Senler,
// см. senler/FILTERS.md — перед боевой рассылкой стоит проверить через `validate`).
async function addExcludeGroupFilter(cdp, campaign, groupId) {
  const requestedGroups = [...new Set((campaign.excludeSubscriberGroups || []).map((value) => String(value).trim()).filter(Boolean))];
  return applySubscriberGroupFilter(cdp, {
    groupId,
    requestedGroups,
    selectName: "filter[ignore_subscription_id][]",
    dropdownValue: "ignore_subscription_id",
    filterLabel: "За исключением группы",
  });
}

async function attachImage(cdp, imagePathValue) {
  const imagePath = resolveProjectPath(imagePathValue);
  await fs.access(imagePath);
  const maxAttempts = 3;
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await evalJson(cdp, `document.querySelectorAll(".message_attachments .attachment_item").length`);
    const imageInput = await findFileInputByAccept(cdp, { acceptIncludes: "image" });
    if (!imageInput) {
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

    const dispatch = await setFileInputFilesAndDispatch(cdp, {
      nodeId: imageInput.nodeId,
      filePath: imagePath,
      normalizeImage: true
    });
    try {
      await waitForImageAttachment(cdp, before, 60000);
      const after = await evalJson(cdp, `document.querySelectorAll(".message_attachments .attachment_item").length`);
      return { imageInput: true, before, after, attached: after > before, attempts: attempt, dispatch };
    } catch (error) {
      const diagnostics = await evalJson(cdp, imageUploadDiagnosticsExpression(before));
      lastFailure = { attempt, imageInput, dispatch, diagnostics, error: error.message };
      if (attempt < maxAttempts) {
        await clearUploadNotices(cdp);
        await sleep(2000 * attempt);
        continue;
      }
    }
  }

  throw new Error(`Image attach failed after ${maxAttempts} attempts: ${lastFailure.error}; ${JSON.stringify(lastFailure)}`);
}

// Принимает новый массив imagePaths и сохраняет совместимость со старым одиночным imagePath.
async function attachImages(cdp, campaign) {
  const imagePaths = [...new Set(
    (Array.isArray(campaign.imagePaths) && campaign.imagePaths.length
      ? campaign.imagePaths
      : [campaign.imagePath])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (!imagePaths.length) return { skipped: true, count: 0, items: [] };

  const items = [];
  for (const imagePath of imagePaths) {
    items.push({ path: imagePath, ...(await attachImage(cdp, imagePath)) });
  }
  return { skipped: false, count: items.length, items };
}

function isVkVideoUrl(value) {
  return /^https:\/\/(?:www\.)?(?:vk\.com|vkvideo\.ru)\//i.test(String(value || "").trim());
}

async function attachVideo(cdp, videoUrl) {
  if (!isVkVideoUrl(videoUrl)) throw new Error(`Invalid VK video URL: ${videoUrl}`);
  const before = await evalJson(cdp, `document.querySelectorAll(".message_attachments .attachment_item").length`);
  const opened = await evalJson(
    cdp,
    `(() => {
      const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const describe = el => [el.innerText, el.textContent, el.title, el.getAttribute("aria-label"), el.dataset?.type, el.dataset?.attachmentType]
        .filter(Boolean).join(" ").trim();
      const candidates = [...document.querySelectorAll('[data-type],[data-attachment-type],button,a,[role="button"],.btn')]
        .filter(visible)
        .filter(el => /(^|\\s)(видео|video)(\\s|$)/i.test(describe(el)));
      const trigger = candidates.find(el => /video/i.test(String(el.dataset?.type || el.dataset?.attachmentType || "")))
        || candidates.find(el => /^(добавить |прикрепить )?(видео|video)$/i.test(describe(el)))
        || candidates[0];
      if (trigger) trigger.click();
      return { clicked: !!trigger, trigger: trigger ? describe(trigger).slice(0, 200) : "", candidates: candidates.map(describe).slice(0, 20) };
    })()`
  );
  if (!opened.clicked) throw new Error(`Senler video attachment control not found: ${JSON.stringify(opened)}`);

  await sleep(500);
  const filled = await evalJson(
    cdp,
    `(() => {
      const videoUrl = ${JSON.stringify(videoUrl)};
      const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const roots = [...document.querySelectorAll('.modal.show,[role="dialog"],.popover.show,.dropdown-menu.show')].filter(visible);
      const root = roots.find(el => /видео|video/i.test(el.innerText || el.textContent || "")) || roots.at(-1) || document;
      const inputs = [...root.querySelectorAll('input[type="url"],input[type="text"],textarea')].filter(visible);
      const input = inputs.find(el => /ссыл|url|видео|video/i.test([el.placeholder, el.name, el.id, el.getAttribute("aria-label")].filter(Boolean).join(" ")))
        || (inputs.length === 1 ? inputs[0] : null);
      if (!input) return { filled: false, roots: roots.length, inputs: inputs.map(el => ({ id: el.id, name: el.name, placeholder: el.placeholder })).slice(0, 20) };
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(input, videoUrl); else input.value = videoUrl;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      return { filled: true, id: input.id || "", name: input.name || "", placeholder: input.placeholder || "" };
    })()`
  );
  if (!filled.filled) throw new Error(`Senler video URL input not found: ${JSON.stringify(filled)}`);

  const startedAt = Date.now();
  let diagnostics = null;
  while (Date.now() - startedAt < 30000) {
    diagnostics = await evalJson(
      cdp,
      `(() => {
        const videoUrl = ${JSON.stringify(videoUrl)};
        const before = ${before};
        const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const after = document.querySelectorAll(".message_attachments .attachment_item").length;
        if (after > before) return { attached: true, before, after };
        const input = [...document.querySelectorAll('input,textarea')].find(el => el.value === videoUrl);
        const visibleRoots = [...document.querySelectorAll('.modal.show,[role="dialog"],.popover.show,.dropdown-menu.show')].filter(visible);
        const root = input?.closest('.modal.show,[role="dialog"],.popover.show,.dropdown-menu.show')
          || visibleRoots.find(el => /видео|video/i.test(el.innerText || el.textContent || ""))
          || input?.parentElement?.parentElement
          || null;
        const links = root ? [...root.querySelectorAll('a,[role="option"],.list-group-item,.dropdown-item')].filter(visible) : [];
        const matchingResult = links.find(el => /video|видео/i.test((el.href || "") + " " + (el.innerText || el.textContent || "")));
        if (matchingResult) matchingResult.click();
        const buttons = root ? [...root.querySelectorAll('button,a,.btn,[role="button"]')].filter(visible) : [];
        const action = buttons.find(el => /^(найти|поиск|добавить|прикрепить|выбрать|сохранить)$/i.test((el.innerText || el.value || el.title || "").trim()));
        if (action) action.click();
        return {
          attached: false,
          before,
          after,
          hasInput: !!input,
          clickedResult: !!matchingResult,
          clickedAction: action ? (action.innerText || action.value || action.title || "").trim() : "",
          buttons: buttons.map(el => (el.innerText || el.value || el.title || "").trim()).filter(Boolean).slice(0, 20)
        };
      })()`
    );
    if (diagnostics.attached) return { url: videoUrl, ...diagnostics };
    await sleep(800);
  }
  throw new Error(`Senler video attachment timed out for ${videoUrl}: ${JSON.stringify(diagnostics)}`);
}

async function attachVideos(cdp, campaign) {
  const videoUrls = [...new Set((campaign.videoUrls || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!videoUrls.length) return { skipped: true, count: 0, items: [] };
  const items = [];
  for (const videoUrl of videoUrls) items.push(await attachVideo(cdp, videoUrl));
  return { skipped: false, count: items.length, items };
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

async function saveMailing(cdp) {
  const clicked = await evalJson(
    cdp,
    `(() => {
      const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      for (const notice of document.querySelectorAll('.alert,.toast,.notification,.invalid-feedback,.text-danger')) {
        if (/Рассылка не заполнена/i.test(notice.innerText || notice.textContent || "")) notice.remove();
      }
      const controls = [...document.querySelectorAll('button,input[type="submit"],a.btn')]
        .filter(visible)
        .filter(el => !el.disabled)
        .filter(el => (el.innerText || el.value || "").trim() === "Сохранить");
      const btn = controls.find(el => el.matches('button[type="submit"],input[type="submit"]'))
        || controls.find(el => el.tagName === "BUTTON")
        || controls[0];
      if (btn) btn.click();
      return {
        clicked: !!btn,
        tag: btn?.tagName || "",
        type: btn?.getAttribute("type") || "",
        className: String(btn?.className || "")
      };
    })()`
  );
  if (!clicked.clicked) throw new Error(`Senler save button not found: ${JSON.stringify(clicked)}`);

  const startedAt = Date.now();
  let status = null;
  while (Date.now() - startedAt < 10000) {
    status = await evalJson(
      cdp,
      `(() => {
        const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const messages = [...document.querySelectorAll('.modal.show,.alert,.toast,.notification,.invalid-feedback,.text-danger')]
          .filter(visible)
          .map(el => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
          .filter(Boolean);
        const body = document.body.innerText || "";
        return {
          saved: messages.some(text => /Рассылка сохранена/i.test(text)) || /Рассылка сохранена/i.test(body),
          empty: messages.some(text => /Рассылка не заполнена/i.test(text)) || /Рассылка не заполнена/i.test(body),
          messages: messages.slice(-10),
          url: location.href
        };
      })()`
    );
    if (status.saved || status.empty) return { ...clicked, ...status };
    await sleep(400);
  }
  throw new Error(`Senler did not confirm mailing save: ${JSON.stringify({ ...clicked, ...status })}`);
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
  const dateFilter = await addDateFilter(cdp, campaign);
  dateFilter.emptyAudienceFallback = await removeDateFilterWhenAudienceIsEmpty(cdp);
  const groupFilter = await addGroupFilter(cdp, campaign, groupId);
  // Как и остальные фильтры выше, ошибка здесь останавливает создание рассылки целиком
  // (не глушим исключение: тихий пропуск означал бы, что исключённая группа всё же получит сообщение).
  const excludeGroupFilter = await addExcludeGroupFilter(cdp, campaign, groupId);
  // Финальная проверка аудитории после ВСЕХ фильтров (дата + группы + исключения).
  // Если получателей 0 — рассылку сохраняем как черновик, но не активируем,
  // и не прерываем обработку остальных групп.
  const recipients = await waitForRecipientCount(cdp);
  if (recipients.found && recipients.count === 0) {
    console.warn(`[warning] Channel ${groupId}: 0 recipients after filters; mailing will be saved but not activated`);
  }
  let image;
  try {
    image = await attachImages(cdp, campaign);
  } catch (error) {
    image = { ok: false, skipped: true, error: error.message };
    console.warn(`[warning] Images were not attached; saving the mailing without images: ${error.message}`);
  }

  let video;
  try {
    video = await attachVideos(cdp, campaign);
  } catch (error) {
    video = { ok: false, skipped: true, error: error.message };
    console.warn(`[warning] Videos were not attached; saving the mailing without videos: ${error.message}`);
  }
  let saved = await saveMailing(cdp);
  if (saved.empty) {
    console.warn("[warning] Senler reported an empty mailing; refilling the editor and retrying save");
    await fillEditor(cdp, campaign);
    saved = await saveMailing(cdp);
  }
  if (!saved.saved) throw new Error(`Senler rejected mailing save: ${JSON.stringify(saved)}`);
  const zeroRecipients = recipients.found && recipients.count === 0;
  const activationAllowed = shouldActivate && !groupFilter.noMatch && !zeroRecipients;
  const activation = activationAllowed
    ? await activateFromModal(cdp)
    : {
        skipped: true,
        reason: groupFilter.noMatch
          ? "subscriber groups not found in channel; mailing left inactive"
          : zeroRecipients
            ? "zero recipients after filters; mailing left inactive"
            : "activation not requested"
      };
  await sleep(3500);
  return { fields, dateFilter, groupFilter, excludeGroupFilter, recipients, image, video, saved, activation };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  const port = Number(args.port || DEFAULT_PORT);
  const groupsPath = path.resolve(ROOT, args.groups || "senler/groups.json");
  const campaignPath = path.resolve(ROOT, args.campaign || "senler/campaign.example.json");
  const groups = await readJson(groupsPath);
  const campaign = await readJson(campaignPath);
  const requestedChannels = String(args.channels || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = selectSenlerChannels(groups, { pick: args.only || "all", channelIds: requestedChannels });
  if (requestedChannels.length && !selected.length) {
    throw new Error("No Senler channels match the selected subjects and channel groups");
  }

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
      try {
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
      } finally {
        tab.ws.close();
      }
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
