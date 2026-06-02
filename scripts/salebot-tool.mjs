import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { buildSaleBotButtons } from "./lib/salebot-buttons.mjs";

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
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
  if (!res.ok) throw new Error(`${method} ${pathname} failed: ${res.status}`);
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
  return { ws, cdp };
}

async function openOrReuse(campaign, port) {
  const targets = await chromeJson("/json/list", port);
  let target = targets.find((t) => t.type === "page" && t.url.includes(`salebot.pro/projects/${campaign.projectId}/messages`));
  if (!target) {
    target = await chromeJson(`/json/new?${encodeURIComponent(campaign.sheetUrl)}`, port, "PUT");
  }
  const tab = await connectTarget(target);
  await tab.cdp("Page.bringToFront");
  await tab.cdp("Runtime.evaluate", { expression: `location.href = ${JSON.stringify(campaign.sheetUrl)}; true`, returnByValue: true });
  return tab;
}

async function openUrl(cdp, url) {
  await cdp("Page.bringToFront");
  await cdp("Runtime.evaluate", { expression: `location.href = ${JSON.stringify(url)}; true`, returnByValue: true });
}

async function evalJson(cdp, expression) {
  const res = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return res.result.value;
}

async function waitFor(cdp, expression, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalJson(cdp, expression)) return;
    await sleep(400);
  }
  throw new Error(`Timeout: ${expression.slice(0, 120)}`);
}

async function setFileInput(cdp, selector, file) {
  await cdp("DOM.enable");
  const document = await cdp("DOM.getDocument", { depth: -1, pierce: true });
  const node = await cdp("DOM.querySelector", { nodeId: document.root.nodeId, selector });
  if (!node.nodeId) throw new Error(`File input not found: ${selector}`);
  await cdp("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [file] });
}

function blockPayload(campaign, type, x, y) {
  const imageUrl = campaign.imageUrl && /^https?:\/\//i.test(campaign.imageUrl) ? campaign.imageUrl : "";
  const base = {
    sheet_id: Number(campaign.sheetId),
    x,
    y,
    message_type: type,
    timeout: "",
    timeout_type: 1,
    condition: "",
    black_list: "",
    priority: 10,
    enter_once: false,
    response_only_to_callback: false,
    enable_markdown: type !== 8,
    enable_html: false,
    protected_content: false,
    disable_notification: false,
    callback_if_seen: false,
    save_to_log: true,
    edit_previous_message: false,
    show_answers: true,
    show_connections_buttons: true,
    enable_snippets: true,
    show_caption_above_media: false,
    action_url: "",
    saved_variables: "",
    headers: "",
    post_params: "",
    variables: "",
    list_action: "",
    actions_settings: "{}",
    attachment_type: imageUrl ? "image" : "",
    attachment_url: imageUrl,
    attachments_settings: imageUrl
      ? JSON.stringify({ attachments: [{ attachment_url: imageUrl, attachment_type: "image", attachment_name: imageUrl.split("/").pop() || "image" }] })
      : "{\"attachments\":[]}",
  };
  if (type === 8) {
    return { ...base, description: campaign.comment || `${campaign.sendDate} - ${campaign.name}`, answer: "", buttons: "" };
  }
  const buttons = buildSaleBotButtons(campaign);
  return {
    ...base,
    description: campaign.name || "",
    answer: String(campaign.message || "").replace(/\\+([.!])/g, "\\$1"),
    buttons: JSON.stringify(buttons),
  };
}

async function inspectPage(cdp) {
  return evalJson(
    cdp,
    `(() => {
      const sheetId = String(${JSON.stringify(String.raw`${""}`)} || window.sheet_param || new URL(location.href).searchParams.get("sheet_id") || "");
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const currentMessages = Array.isArray(window.messages) ? window.messages.filter((m) => String(m.sheet_id) === String(window.sheet_param)) : [];
      return {
        url: location.href,
        title: document.title,
        loggedIn: document.body.innerText.includes("Конструктор"),
        sheetParam: window.sheet_param || "",
        messagesCount: currentMessages.length,
        maxX: currentMessages.length ? Math.max(...currentMessages.map((m) => Number(m.x) || 0)) : null,
        maxY: currentMessages.length ? Math.max(...currentMessages.map((m) => Number(m.y) || 0)) : null,
        hasCreateApi: typeof window.ajaxCreateMessage === "function",
        hasMessages: Array.isArray(window.messages),
        visibleButtons: [...document.querySelectorAll("button,a,[role=button],.btn")]
          .filter(visible)
          .map((el) => (el.innerText || el.textContent || el.getAttribute("title") || "").trim().replace(/\\s+/g, " "))
          .filter(Boolean)
          .slice(0, 40)
      };
    })()`
  );
}

async function createBlocks(cdp, campaign) {
  await waitFor(cdp, `document.body.innerText.includes("Конструктор") && Array.isArray(window.messages) && typeof window.ajaxCreateMessage === "function"`, 40000);
  return evalJson(
    cdp,
    `(() => new Promise((resolve) => {
      const campaign = ${JSON.stringify(campaign)};
      const buildSaleBotButtons = ${buildSaleBotButtons.toString()};
      const makePayload = ${blockPayload.toString()};
      const audiences = campaign.selectedAudiences?.length ? campaign.selectedAudiences : [campaign.audience].filter(Boolean);
      const campaigns = audiences.length ? audiences.map((audience) => ({
        ...campaign,
        audience,
        name: audience.name ? campaign.name + " - " + audience.name : campaign.name,
        comment: campaign.sendDate + " - " + campaign.name + (audience.name ? " - " + audience.name : "")
      })) : [campaign];
      const sheetMessages = window.messages.filter((m) => String(m.sheet_id) === String(campaign.sheetId));
      const maxY = sheetMessages.length ? Math.max(...sheetMessages.map((m) => Number(m.y) || 0)) : 0;
      const x = sheetMessages.length ? Math.max(120, Math.min(2600, Math.round(sheetMessages.reduce((s, m) => s + (Number(m.x) || 0), 0) / sheetMessages.length))) : 500;
      const ids = () => new Set(Object.keys(window.items || {}));
      const messageFromId = (id) => window.items?.[id]?.prop?.("message") || null;
      const findByPayload = (payload, beforeIds) => {
        const candidates = Object.keys(window.items || {})
          .filter((id) => !beforeIds.has(id))
          .map(messageFromId)
          .filter(Boolean)
          .filter((m) => String(m.sheet_id) === String(payload.sheet_id))
          .filter((m) => Number(m.message_type) === Number(payload.message_type))
          .filter((m) => Number(m.x) === Number(payload.x) && Number(m.y) === Number(payload.y));
        return candidates.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
      };
      const create = (payload) => new Promise((res, rej) => {
        const beforeIds = ids();
        window.ajaxCreateMessage(payload).done((data) => {
          setTimeout(() => {
            const fromItems = findByPayload(payload, beforeIds);
            const fromData = data?.message || (data && typeof data === "object" ? data : null);
            res(fromItems || fromData || null);
          }, 300);
        }).fail((xhr) => rej(new Error(xhr.responseText || xhr.statusText || "SaleBot create failed")));
      });
      campaigns.reduce((chain, item, index) => chain.then(async (acc) => {
        const y = maxY + 120 + index * 150;
        const commentPayload = makePayload(item, 8, x, y);
        const textPayload = makePayload(item, 0, x, y + 70);
        const commentResult = await create(commentPayload);
        const textResult = await create(textPayload);
        const comment = commentResult?.message || commentResult;
        const text = textResult?.message || textResult;
        acc.push({ audience: item.audience, commentId: comment?.id || null, textId: text?.id || null, x, commentY: y, textY: y + 70 });
        return acc;
      }), Promise.resolve([]))
        .then((items) => {
          resolve({ ok: true, count: items.length, items });
        })
        .catch((error) => resolve({ ok: false, error: error.stack || error.message }));
    }))()`
  );
}

async function openMessageEditor(cdp, messageId) {
  const result = await evalJson(
    cdp,
    `(() => new Promise((resolve) => {
      window.ajaxEditMessage(${JSON.stringify(messageId)})
        .done((code) => {
          try {
            window.eval(code);
            setTimeout(() => resolve({ ok: true, form: document.querySelector("form")?.id || "" }), 800);
          } catch (error) {
            resolve({ ok: false, error: error.stack || error.message });
          }
        })
        .fail((xhr) => resolve({ ok: false, error: xhr.responseText || xhr.statusText || "SaleBot edit failed" }));
    }))()`
  );
  if (!result?.ok) throw new Error(`SaleBot editor open failed for ${messageId}: ${result?.error || "unknown error"}`);
  await waitFor(cdp, `!!document.querySelector("#edit_message_${messageId} #message_file")`, 20000);
}

async function attachImageToMessage(cdp, messageId, imagePath) {
  await fs.access(imagePath);
  await openMessageEditor(cdp, messageId);
  await evalJson(
    cdp,
    `(() => {
      const button = document.querySelector('.attachment-list__btn--js[data-type="image"]');
      if (!button) return false;
      if (!button.classList.contains("btn-active__blue")) button.click();
      return document.querySelector("#message_attachment_type")?.value === "image";
    })()`
  );
  await setFileInput(cdp, "#message_file", imagePath);
  const upload = await evalJson(
    cdp,
    `(() => new Promise((resolve) => {
      const before = [...document.querySelectorAll(".ident_id")].map((el) => el.textContent.trim()).filter(Boolean).length;
      document.querySelector("#message_file").dispatchEvent(new Event("change", { bubbles: true }));
      const start = Date.now();
      const timer = setInterval(() => {
        const ids = [...document.querySelectorAll(".ident_id")].map((el) => el.textContent.trim()).filter(Boolean);
        const loading = !!document.querySelector(".file_loading");
        const previewText = document.querySelector(".preview_files_container")?.innerText || "";
        const toast = [...document.querySelectorAll(".toast,.toast-content")].map((el) => el.innerText).join("\\n");
        if (ids.length > before && !loading) {
          clearInterval(timer);
          resolve({ ok: true, before, after: ids.length, ids, previewText });
        }
        if (Date.now() - start > 45000) {
          clearInterval(timer);
          resolve({ ok: false, before, after: ids.length, ids, loading, previewText, toast });
        }
      }, 500);
    }))()`
  );
  if (!upload?.ok) throw new Error(`SaleBot image upload failed for ${messageId}: ${JSON.stringify(upload)}`);
  const saved = await evalJson(
    cdp,
    `(() => new Promise((resolve) => {
      window.save_message(false, true);
      setTimeout(() => resolve({
        ok: true,
        form: document.querySelector("form")?.id || "",
        ids: [...document.querySelectorAll(".ident_id")].map((el) => el.textContent.trim()).filter(Boolean)
      }), 5000);
    }))()`
  );
  return { ok: true, messageId, upload, saved };
}

function splitDateTime(value) {
  const match = String(value || "").match(/^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})$/);
  if (!match) throw new Error(`Bad SaleBot sendDate, expected DD.MM.YYYY HH:mm: ${value}`);
  return { date: match[1], time: match[2] };
}

function audienceTags(audience) {
  const knownTags = new Map([
    ["сдает_егэ_2026", "#1727763 сдает_егэ_2026"],
  ]);
  return (audience?.tags || [audience?.tag].filter(Boolean))
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .map((tag) => knownTags.get(tag) || tag);
}

function mailingName(campaign, audience) {
  const date = String(campaign.sendDate || "").slice(0, 5);
  const parts = [date, campaign.name, audience?.name].filter(Boolean);
  return parts.join(" - ");
}

async function fillMailingForm(cdp, campaign, item, schedule) {
  const { date, time } = splitDateTime(campaign.sendDate);
  const audience = item.audience || campaign.audience || {};
  const tags = audienceTags(audience);
  const result = await evalJson(
    cdp,
    `(() => {
      const campaign = ${JSON.stringify(campaign)};
      const audience = ${JSON.stringify(audience)};
      const tags = ${JSON.stringify(tags)};
      const mailingName = ${JSON.stringify(mailingName(campaign, audience))};
      const sendDate = ${JSON.stringify(date)};
      const sendTime = ${JSON.stringify(time)};
      const schedule = ${JSON.stringify(Boolean(schedule))};
      const setValue = (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      const check = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      const ensureOption = (select, value, text) => {
        if (!select || !value) return false;
        let option = [...select.options].find((item) => String(item.value) === String(value));
        if (!option) {
          option = new Option(text || value, value, true, true);
          select.append(option);
        }
        option.selected = true;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        if (window.$) window.$(select).trigger("change");
        return true;
      };
      const findTagOption = (select, tag) => {
        const clean = String(tag || "").trim();
        const id = clean.match(/^#?(\\d+)/)?.[1] || "";
        return [...select.options].find((option) => {
          const text = option.textContent || "";
          return (id && String(option.value) === id) || (id && text.includes("#" + id)) || text.includes(clean.replace(/^#\\d+\\s*/, ""));
        });
      };
      const selectTag = (select, tag) => {
        const clean = String(tag || "").trim();
        const id = clean.match(/^#?(\\d+)/)?.[1] || "";
        let option = findTagOption(select, clean);
        if (!option && id) {
          option = new Option(clean, id, true, true);
          select.append(option);
        }
        if (!option) return null;
        option.selected = true;
        return { text: option.textContent, value: option.value };
      };
      const nameOk = setValue("#mailing_name", mailingName);
      check("#mailing_set_job_timer_0");
      if (audience.bot) {
        ensureOption(document.querySelector("#mailing_client_type"), audience.bot, "Telegram: " + audience.bot);
      }
      const listSelect = document.querySelector("#mailing_list_id");
      const selectedTags = [];
      const missingTags = [];
      for (const tag of tags) {
        const selected = selectTag(listSelect, tag);
        if (selected) {
          selectedTags.push(selected);
        } else {
          missingTags.push(tag);
        }
      }
      if (listSelect) {
        listSelect.dispatchEvent(new Event("change", { bubbles: true }));
        if (window.$) window.$(listSelect).trigger("change");
      }
      check("#mailing_except_unsubscribed");
      check("#mailing_send_now_1");
      setValue("#mailing_date", sendDate);
      setValue("#mailing_time", sendTime);
      setValue("#mailing_interval", "1");
      setValue("#mailing_offset", "");
      setValue("#mailing_limit", "");
      const saveLog = document.querySelector("#mailing_save_to_log");
      if (saveLog) {
        saveLog.checked = false;
        saveLog.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const startId = document.querySelector("#mailing_start_message")?.value || "";
      const buttonsRaw = document.querySelector("#mailing_buttons")?.value || "[]";
      let buttons = [];
      try { buttons = JSON.parse(buttonsRaw); } catch {}
      return {
        ok: nameOk && !!startId && buttons.some((button) => button.type === "inline") && !missingTags.length,
        mailingId: location.pathname.match(/mailings\\/(\\d+)/)?.[1] || "",
        startId,
        name: document.querySelector("#mailing_name")?.value || "",
        bot: audience.bot || "",
        selectedTags,
        missingTags,
        date: document.querySelector("#mailing_date")?.value || "",
        time: document.querySelector("#mailing_time")?.value || "",
        interval: document.querySelector("#mailing_interval")?.value || "",
        inlineButtons: buttons.filter((button) => button.type === "inline").length,
        schedule,
        sendNow0: document.querySelector("#mailing_send_now_0")?.checked || false,
        sendNow1: document.querySelector("#mailing_send_now_1")?.checked || false
      };
    })()`
  );
  if (!result?.ok) throw new Error(`SaleBot mailing fill failed: ${JSON.stringify(result)}`);
  return result;
}

async function submitMailing(cdp, schedule) {
  const result = await evalJson(
    cdp,
    `(() => new Promise((resolve) => {
      const shouldSchedule = ${JSON.stringify(Boolean(schedule))};
      const startedAt = Date.now();
      const textOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ");
      const isUsable = (el) => el && !el.disabled && !el.closest("[disabled]") && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const listButtons = () => [...document.querySelectorAll("button,input[type=submit],input[type=button],a.btn,.btn,.save_draft_btn")]
        .map((el, index) => ({
          index,
          text: textOf(el),
          tag: el.tagName,
          type: el.type || "",
          className: String(el.className || ""),
          disabled: !!el.disabled,
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
        }))
        .filter((item) => item.text || item.className);
      const findButton = () => {
        window.scrollTo(0, document.body.scrollHeight);
        const candidates = [...document.querySelectorAll("button,input[type=submit],input[type=button],a.btn,.btn,.save_draft_btn")]
          .filter(isUsable);
        if (!shouldSchedule) {
          return document.querySelector(".save_draft_btn") || candidates.find((el) => /сохран/i.test(textOf(el)));
        }
        const sendButton = [...document.querySelectorAll(".send_mailing_btn")]
          .find((el) => !el.disabled && !el.closest("[disabled]"));
        if (sendButton) return sendButton;
        const textMatches = [
          /запустить\\s+рассылку/i,
          /запустить/i,
          /запланировать\\s+рассылку/i,
          /запланировать/i
        ];
        return candidates
          .filter((el) => !String(el.className || "").includes("save_draft_btn"))
          .find((el) => textMatches.some((pattern) => pattern.test(textOf(el))));
      };
      const tick = () => {
        const button = findButton();
        if (button) {
          const clicked = {
            text: textOf(button),
            tag: button.tagName,
            type: button.type || "",
            className: String(button.className || "")
          };
          if (shouldSchedule && !/send_mailing_btn|запустить|запланировать/i.test(clicked.className + " " + clicked.text)) {
            resolve({ ok: false, error: "refusing non-schedule button", schedule: shouldSchedule, clicked, buttons: listButtons(), body: document.body.innerText.slice(0, 1200) });
            return;
          }
          button.click();
          setTimeout(() => resolve({ ok: true, clicked, url: location.href, body: document.body.innerText.slice(0, 1000) }), 7000);
          return;
        }
        if (Date.now() - startedAt > 15000) {
          resolve({ ok: false, error: "button not found", schedule: shouldSchedule, buttons: listButtons(), body: document.body.innerText.slice(0, 1200) });
          return;
        }
        setTimeout(tick, 500);
      };
      tick();
    }))()`
  );
  if (!result?.ok) throw new Error(`SaleBot mailing submit failed: ${JSON.stringify(result)}`);
  return result;
}

async function createMailings(cdp, campaign, items, schedule) {
  const results = [];
  for (const item of items || []) {
    if (!item.textId) throw new Error(`No text block id for audience ${item.audience?.name || ""}`);
    const url = `https://salebot.pro/projects/${campaign.projectId}/mailings/new?is_from_block=true&message=${encodeURIComponent(item.textId)}`;
    await openUrl(cdp, url);
    await waitFor(cdp, `!!document.querySelector("#mailing_start_message") && !!document.querySelector("#mailing_text")`, 120000);
    const fill = await fillMailingForm(cdp, campaign, item, schedule);
    if (String(fill.startId) !== String(item.textId)) {
      throw new Error(`SaleBot mailing start block mismatch: expected ${item.textId}, got ${fill.startId}`);
    }
    const submit = await submitMailing(cdp, schedule);
    results.push({ audience: item.audience, textId: item.textId, mailingId: fill.mailingId, fill, submit });
    await sleep(1000);
  }
  return results;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  const port = Number(args.port || DEFAULT_PORT);
  const campaignPath = path.resolve(ROOT, args.campaign || "salebot/campaign.example.json");
  const campaign = await readJson(campaignPath);

  if (command === "help") {
    console.log(`Usage:
  npm run salebot -- open
  npm run salebot -- inspect
  npm run salebot -- create-blocks --confirm-create
  npm run salebot -- create-drafts --confirm-create
  npm run salebot -- schedule --confirm-create --confirm-schedule
`);
    return;
  }

  const tab = await openOrReuse(campaign, port);
  await sleep(5000);

  if (command === "open") {
    console.log(`[open] ${campaign.sheetUrl}`);
    tab.ws.close();
    return;
  }

  if (command === "inspect") {
    console.log(JSON.stringify(await inspectPage(tab.cdp), null, 2));
    tab.ws.close();
    return;
  }

  if (command === "create-blocks" || command === "create-drafts" || command === "schedule") {
    if (!args["confirm-create"]) throw new Error("Refusing to create SaleBot blocks without --confirm-create");
    if (command === "schedule" && !args["confirm-schedule"]) throw new Error("Refusing to schedule SaleBot mailings without --confirm-schedule");
    const result = await createBlocks(tab.cdp, campaign);
    if (result.ok && campaign.imagePath && !campaign.imageUrl) {
      result.attachments = [];
      for (const item of result.items || []) {
        if (!item.textId) continue;
        result.attachments.push(await attachImageToMessage(tab.cdp, item.textId, campaign.imagePath));
      }
    }
    if (result.ok && (command === "create-drafts" || command === "schedule")) {
      result.mailings = await createMailings(tab.cdp, campaign, result.items, command === "schedule");
    }
    console.log(JSON.stringify(result, null, 2));
    tab.ws.close();
    if (!result.ok) process.exit(1);
    return;
  }

  tab.ws.close();
  throw new Error(`Unknown command: ${command}`);
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
