import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = Number(process.env.SENLER_UI_PORT || 4317);
const CAMPAIGN_FILE = path.join(ROOT, "senler", "campaign.ui.json");
const EXAMPLE_FILE = path.join(ROOT, "senler", "campaign.example.json");
const SENLER_GROUPS_FILE = path.join(ROOT, "senler", "groups.json");
const SALEBOT_CAMPAIGN_FILE = path.join(ROOT, "salebot", "campaign.ui.json");
const SALEBOT_EXAMPLE_FILE = path.join(ROOT, "salebot", "campaign.example.json");
const SALEBOT_AUDIENCES_FILE = path.join(ROOT, "salebot", "audiences.json");
const SALEBOT_SHEET_URL = "https://salebot.pro/projects/399135/messages?sheet_id=385867";
const SALEBOT_PROJECT_ID = "399135";
const SALEBOT_SHEET_ID = "385867";
const UPLOAD_DIR = path.join(ROOT, "senler", "uploads");
const LOG_DIR = path.join(ROOT, "senler", "logs");
const LOG_FILE = path.join(LOG_DIR, "senler-ui.log");

async function appendLog(event, payload = {}) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload,
  });
  await fs.appendFile(LOG_FILE, `${line}\n`, "utf8");
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function getBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function runTool(script, args, logPrefix = "command") {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      await appendLog(`${logPrefix}.timeout`, { script, args, durationMs: Date.now() - startedAt });
      resolve({ code: 1, output: "Команда выполнялась слишком долго и была остановлена. Проверь лог и текущую вкладку браузера." });
    }, 10 * 60 * 1000);
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await appendLog(`${logPrefix}.spawn_error`, { script, args, error: error.stack || error.message });
      resolve({ code: 1, output: error.stack || error.message });
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await appendLog(`${logPrefix}.finish`, { script, args, code, durationMs: Date.now() - startedAt, outputTail: output.slice(-4000) });
      resolve({ code, output });
    });
  });
}

function runSenler(args) {
  return runTool("scripts/senler-tool.mjs", args, "command");
}

function runSalebot(args) {
  return runTool("scripts/salebot-tool.mjs", args, "salebot");
}

const page = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Senler рассылки</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Segoe UI, Arial, sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #1f2933; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 18px; }
    .tabs { display: flex; gap: 8px; margin: 0 0 18px; border-bottom: 1px solid #d8dee6; }
    .tab-button { border-radius: 6px 6px 0 0; background: transparent; border: 1px solid transparent; border-bottom: 0; color: #536173; }
    .tab-button.active { background: #fff; border-color: #d8dee6; color: #17202a; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; align-items: start; }
    section, aside { background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 16px; }
    .wide { margin-top: 18px; }
    label { display: block; font-size: 13px; font-weight: 650; margin: 12px 0 6px; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #c7d0dc; border-radius: 6px; padding: 10px; font: inherit; background: #fff; }
    textarea { min-height: 320px; resize: vertical; line-height: 1.35; }
    textarea.compact { min-height: 90px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid #c7d0dc; border-bottom: 0; border-radius: 6px 6px 0 0; padding: 8px; background: #f8fafc; }
    .toolbar button { min-width: 36px; height: 34px; padding: 0; border: 1px solid #c7d0dc; background: #fff; }
    .toolbar button.active { background: #dbeafe; border-color: #60a5fa; }
    .toolbar select { width: auto; min-width: 170px; min-height: 34px; padding: 6px 30px 6px 9px; font-size: 13px; }
    #editor { min-height: 360px; border: 1px solid #c7d0dc; border-radius: 0 0 6px 6px; padding: 12px; line-height: 1.4; white-space: pre-wrap; outline: none; background: #fff; overflow: auto; }
    #sbEditor { min-height: 280px; border: 1px solid #c7d0dc; border-radius: 0 0 6px 6px; padding: 12px; line-height: 1.4; white-space: pre-wrap; outline: none; background: #fff; overflow: auto; }
    #editor:focus, #sbEditor:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.12); }
    #editor a, #sbEditor a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
    #editor code, #sbEditor code { padding: 1px 4px; border-radius: 4px; background: #eef2f7; color: #111827; font-family: Consolas, Menlo, monospace; font-size: .92em; }
    #editor pre, #sbEditor pre { margin: 8px 0; padding: 10px; border-radius: 6px; background: #111827; color: #d1fae5; font-family: Consolas, Menlo, monospace; font-size: 13px; white-space: pre-wrap; }
    #editor .tg-spoiler, #sbEditor .tg-spoiler { border-radius: 4px; background: #d8dee6; color: transparent; }
    #editor .tg-spoiler:hover, #sbEditor .tg-spoiler:hover { color: inherit; }
    #editor blockquote, #sbEditor blockquote { margin: 8px 0; padding: 6px 10px; border-left: 3px solid #94a3b8; color: #475569; background: #f8fafc; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; align-items: center; }
    .action-bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-top: 14px; align-items: center; }
    .action-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .final-action { margin-left: auto; padding-left: 10px; border-left: 1px solid #d8dee6; }
    button { border: 0; border-radius: 6px; padding: 7px 10px; min-height: 34px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; background: #e6ebf2; color: #17202a; }
    button.primary { background: #2563eb; color: white; }
    button.final { background: #16a34a; color: white; }
    button.danger { background: #dc2626; color: white; }
    button:disabled { opacity: .55; cursor: wait; }
    select.action-select { width: auto; min-width: 210px; min-height: 34px; padding: 7px 32px 7px 10px; font-size: 13px; font-weight: 650; }
    .hint { color: #5d6b7a; font-size: 13px; line-height: 1.4; }
    .groups { display: grid; gap: 10px; }
    .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .check label { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 650; }
    .check input { width: auto; }
    .check button { padding: 6px 10px; font-size: 13px; }
    #sbAudiences .check { justify-content: space-between; }
    pre { margin: 14px 0 0; max-height: 420px; overflow: auto; background: #111827; color: #d1fae5; padding: 12px; border-radius: 8px; font-size: 12px; white-space: pre-wrap; }
    .warn { background: #fff7ed; border: 1px solid #fed7aa; color: #7c2d12; padding: 10px; border-radius: 6px; font-size: 13px; }
    details.setup { margin-top: 10px; border: 1px solid #d8dee6; border-radius: 6px; background: #f8fafc; }
    details.setup summary { cursor: pointer; padding: 10px; font-size: 13px; font-weight: 700; color: #1f2933; }
    details.setup .setup-body { border-top: 1px solid #d8dee6; padding: 10px; }
    details.setup code { display: block; margin-top: 8px; padding: 10px; border-radius: 6px; background: #111827; color: #d1fae5; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .log-actions { display: flex; gap: 8px; margin-top: 10px; }
    @media (max-width: 900px) { .grid, .row { grid-template-columns: 1fr; } main { padding: 14px; } .action-bar { display: grid; } .final-action { margin-left: 0; padding-left: 0; border-left: 0; } select.action-select { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <h1>Рассылки</h1>
    <div class="tabs" role="tablist">
      <button id="tabSenler" class="tab-button active" type="button">Senler</button>
      <button id="tabSaleBot" class="tab-button" type="button">SaleBot / Telegram</button>
      <button id="tabCommunities" class="tab-button" type="button">Сообщества</button>
      <button id="tabAudiences" class="tab-button" type="button">Аудитории</button>
    </div>
    <div id="panelSenler" class="tab-panel active">
    <div class="grid">
      <section>
        <div class="row">
          <div>
            <label>Название рассылки</label>
            <input id="name">
          </div>
          <div>
            <label>Дата рассылки</label>
            <input id="sendDate" type="datetime-local">
          </div>
        </div>
        <div class="row">
          <div>
            <label>Дата подписки с</label>
            <input id="subscriptionFrom" placeholder="01.06.2025 00:00">
          </div>
          <div>
            <label>Путь к картинке</label>
            <input id="imagePath">
            <input id="imageFile" type="file" accept="image/*" style="margin-top:8px">
          </div>
        </div>
        <label>Текст рассылки</label>
        <div class="toolbar" aria-label="Форматирование текста">
          <button type="button" data-editor="editor" data-cmd="bold" title="Жирный"><b>B</b></button>
          <button type="button" data-editor="editor" data-cmd="italic" title="Курсив"><i>I</i></button>
          <button type="button" data-editor="editor" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
          <button type="button" data-editor="editor" data-format-link title="Ссылка">Link</button>
          <select id="senlerVariable" aria-label="Переменные Senler">
            <option value="">Переменные</option>
            <option value="%username%">%username%</option>
            <option value="%fullname%">%fullname%</option>
            <option value="%userid%">%userid%</option>
            <option value="%domain%">%domain%</option>
            <option value="{%email%}">{%email%}</option>
            <option value="[%var%]">[%var%]</option>
            <option value="[rand]текст 1|текст 2|текст 3[/rand]">[rand]текст 1|текст 2|текст 3[/rand]</option>
            <option value="[date]%e %month|+1 day[/date]">[date]%e %month|+1 day[/date]</option>
            <option value="__custom_user__">__custom_user__</option>
            <option value="__custom_global__">__custom_global__</option>
          </select>
        </div>
        <div id="editor" contenteditable="true"></div>
        <div class="action-bar">
          <div class="action-group">
            <button id="save" class="primary">Сохранить</button>
            <button id="openTabs">Открыть вкладки</button>
            <button id="validate">Проверить</button>
          </div>
          <div class="action-group final-action">
            <button id="run" class="final">Создать и активировать</button>
          </div>
        </div>
      </section>
      <aside>
        <div class="warn">Перед созданием убедись, что Chrome запущен с remote debugging и ты залогинен в Senler.</div>
        <details class="setup">
          <summary>Команды запуска браузера</summary>
          <div class="setup-body command-setup" data-start-url="https://senler.ru/">
            <div class="hint" style="margin-top:10px">Windows PowerShell:</div>
            <code class="cmdWin"></code>
            <div class="hint" style="margin-top:10px">macOS Terminal:</div>
            <code class="cmdMac"></code>
          </div>
        </details>
        <label>Группы</label>
        <div class="groups">
          <label class="check"><input type="checkbox" value="ege" checked> ЕГЭ</label>
          <label class="check"><input type="checkbox" value="oge" checked> ОГЭ</label>
          <label class="check"><input type="checkbox" value="common" checked> Общий</label>
        </div>
        <p class="hint">Кнопка создания требует отдельного подтверждения. Проверка и открытие вкладок ничего не отправляют.</p>
        <div class="log-actions">
          <button id="showLog">Показать лог</button>
          <button id="clearLog">Очистить лог</button>
        </div>
        <pre id="log">Готово.</pre>
      </aside>
    </div>
    </div>
    <div id="panelSaleBot" class="tab-panel">
      <div class="grid">
        <section>
          <h2 style="font-size:20px;margin:0 0 12px">SaleBot / Telegram</h2>
          <div class="row">
            <div>
              <label>Название рассылки</label>
              <input id="sbName">
            </div>
            <div>
              <label>Дата рассылки</label>
              <input id="sbSendDate" type="datetime-local">
            </div>
          </div>
          <label>Текст блока</label>
          <div class="toolbar" aria-label="Форматирование текста SaleBot">
            <button type="button" data-editor="sbEditor" data-cmd="bold" title="Жирный"><b>B</b></button>
            <button type="button" data-editor="sbEditor" data-cmd="italic" title="Курсив"><i>I</i></button>
            <button type="button" data-editor="sbEditor" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
            <button type="button" data-editor="sbEditor" data-cmd="strikeThrough" title="Зачёркнутый"><s>S</s></button>
            <button type="button" data-editor="sbEditor" data-inline-code title="Код">Code</button>
            <button type="button" data-editor="sbEditor" data-code-block title="Блок кода">Pre</button>
            <button type="button" data-editor="sbEditor" data-spoiler title="Спойлер">Spoiler</button>
            <button type="button" data-editor="sbEditor" data-quote title="Цитата">Quote</button>
            <button type="button" data-editor="sbEditor" data-format-link title="Ссылка">Link</button>
          </div>
          <div id="sbEditor" contenteditable="true"></div>
          <div class="row">
            <div>
              <label>Текст кнопки</label>
              <input id="sbButtonText">
            </div>
            <div>
              <label>Ссылка кнопки</label>
              <input id="sbButtonUrl">
            </div>
          </div>
          <div class="row">
            <div>
              <label>Картинка SaleBot</label>
              <input id="sbImagePath">
              <input id="sbImageFile" type="file" accept="image/*" style="margin-top:8px">
            </div>
          </div>
          <div class="action-bar">
            <div class="action-group">
              <button id="sbSave" class="primary">Сохранить</button>
              <button id="sbOpen">Открыть</button>
              <button id="sbInspect">Проверить</button>
            </div>
            <div class="action-group final-action">
              <select id="sbFinalAction" class="action-select" aria-label="Финальное действие SaleBot">
                <option value="create-blocks">Создать блоки</option>
                <option value="create-drafts">Создать блоки и черновики</option>
                <option value="schedule">Создать и запланировать</option>
              </select>
              <button id="sbRunFinal" class="final">Выполнить</button>
            </div>
          </div>
        </section>
        <aside>
          <div class="warn">Перед созданием убедись, что Chrome запущен с remote debugging и ты залогинен в SaleBot.</div>
          <details class="setup">
            <summary>Команды запуска браузера</summary>
            <div class="setup-body command-setup" data-start-url="https://salebot.pro/">
              <div class="hint" style="margin-top:10px">Windows PowerShell:</div>
              <code class="cmdWin"></code>
              <div class="hint" style="margin-top:10px">macOS Terminal:</div>
              <code class="cmdMac"></code>
            </div>
          </details>
          <label>Аудитории</label>
          <div id="sbAudiences" class="groups"></div>
          <p class="hint">Для каждой выбранной аудитории SaleBot создаст свой блок и свою рассылку. Кнопка всегда будет в тексте.</p>
          <div class="log-actions">
            <button id="sbShowLog">Показать лог</button>
            <button id="sbClearLog">Очистить лог</button>
          </div>
          <pre id="sbLog">Готово.</pre>
        </aside>
      </div>
    </div>
    <section id="panelCommunities" class="tab-panel">
      <h2 style="font-size:20px;margin:0 0 12px">Редактор сообществ Senler</h2>
      <p class="hint">Указывай ID сообществ, каждый с новой строки. Можно вставлять и ссылки Senler, утилита сама возьмёт ID из конца ссылки.</p>
      <div class="row">
        <div>
          <label>ЕГЭ</label>
          <textarea id="groupEge" class="compact" placeholder="430334"></textarea>
        </div>
        <div>
          <label>ОГЭ</label>
          <textarea id="groupOge" class="compact" placeholder="888302"></textarea>
        </div>
      </div>
      <label>Общий</label>
      <textarea id="groupCommon" class="compact" placeholder="436769"></textarea>
      <div class="actions">
        <button id="groupsReload" type="button">Обновить из файла</button>
        <button id="groupsSave" type="button" class="primary">Сохранить сообщества</button>
      </div>
      <p class="hint">После сохранения кнопки Senler “Открыть вкладки”, “Проверить” и “Создать” будут использовать обновлённый список.</p>
    </section>
    <section id="panelAudiences" class="tab-panel">
      <h2 style="font-size:20px;margin:0 0 12px">Редактор аудиторий</h2>
      <label>Выбрать аудиторию для редактирования</label>
      <select id="audSelect"></select>
      <label>Название аудитории</label>
      <input id="audName">
      <div class="row">
        <div><label>Бот</label><input id="audBot" placeholder="egehubref_bot"></div>
        <div><label>Теги, каждый с новой строки</label><textarea id="audTags" class="compact" placeholder="сдает_егэ_2026"></textarea></div>
      </div>
      <div class="actions">
        <button id="audNew" type="button">Новая аудитория</button>
        <button id="audAdd" type="button">Сохранить аудиторию</button>
        <button id="audDelete" type="button">Удалить выбранные</button>
        <button id="audSave" type="button" class="primary">Сохранить список</button>
      </div>
      <p class="hint">Удаление работает по аудиториям, отмеченным на вкладке SaleBot / Telegram.</p>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const log = (text) => {
      if ($("log")) $("log").textContent = text;
      if ($("sbLog")) $("sbLog").textContent = text;
    };
    const selectedGroups = () => [...document.querySelectorAll("#panelSenler .groups input:checked")].map(x => x.value).join(",");
    const selectedSaleBotAudienceIds = () => [...document.querySelectorAll("#sbAudiences input:checked")].map(x => x.value);
    function activateTab(name) {
      const saleBot = name === "salebot";
      const audiences = name === "audiences";
      const communities = name === "communities";
      $("tabSenler").classList.toggle("active", !saleBot && !audiences && !communities);
      $("tabSaleBot").classList.toggle("active", saleBot);
      $("tabCommunities").classList.toggle("active", communities);
      $("tabAudiences").classList.toggle("active", audiences);
      $("panelSenler").classList.toggle("active", !saleBot && !audiences && !communities);
      $("panelSaleBot").classList.toggle("active", saleBot);
      $("panelCommunities").classList.toggle("active", communities);
      $("panelAudiences").classList.toggle("active", audiences);
      localStorage.setItem("mailing-ui-tab", audiences ? "audiences" : communities ? "communities" : saleBot ? "salebot" : "senler");
    }
    $("tabSenler").onclick = () => activateTab("senler");
    $("tabSaleBot").onclick = () => activateTab("salebot");
    $("tabCommunities").onclick = () => activateTab("communities");
    $("tabAudiences").onclick = () => activateTab("audiences");
    activateTab(localStorage.getItem("mailing-ui-tab") || "senler");
    const saleBotSheetUrl = ${JSON.stringify(SALEBOT_SHEET_URL)};
    const saleBotProjectId = ${JSON.stringify(SALEBOT_PROJECT_ID)};
    const saleBotSheetId = ${JSON.stringify(SALEBOT_SHEET_ID)};
    function toDateTimeLocal(value) {
      const match = String(value || "").match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})\\s+(\\d{2}):(\\d{2})/);
      if (!match) return "";
      return match[3] + "-" + match[2] + "-" + match[1] + "T" + match[4] + ":" + match[5];
    }
    function fromDateTimeLocal(value) {
      const match = String(value || "").match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/);
      if (!match) return value || "";
      return match[3] + "." + match[2] + "." + match[1] + " " + match[4] + ":" + match[5];
    }
    function renderCommands() {
      document.querySelectorAll(".command-setup").forEach(box => {
        const url = box.dataset.startUrl || "https://senler.ru/";
        box.querySelector(".cmdWin").textContent = "& \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --remote-debugging-port=9222 --user-data-dir=\"$env:USERPROFILE\\Documents\\Codex\\chrome-senler\" " + url;
        box.querySelector(".cmdMac").textContent = "open -na \"Google Chrome\" --args --remote-debugging-port=9222 --user-data-dir=\"$HOME/Documents/Codex/chrome-senler\" " + url;
      });
    }
    renderCommands();
    function connectLiveReload() {
      if (!window.EventSource) return;
      const source = new EventSource("/api/live-reload");
      let retryTimer = null;
      source.onmessage = (event) => {
        if (event.data === "reload") location.reload();
      };
      source.onerror = () => {
        source.close();
        clearTimeout(retryTimer);
        const tryReload = () => {
          fetch(location.href, { cache: "no-store" })
            .then(() => location.reload())
            .catch(() => { retryTimer = setTimeout(tryReload, 800); });
        };
        retryTimer = setTimeout(tryReload, 800);
      };
    }
    connectLiveReload();
    function escapeHtml(text) {
      return text.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
    }
    function renderEditor(text, formats) {
      const flags = Array.from({ length: text.length }, () => ({ bold: false, italic: false, underline: false, link: "" }));
      for (const fmt of formats || []) {
        const start = Math.max(0, Number(fmt.offset) || 0);
        const end = Math.min(text.length, start + (Number(fmt.length) || 0));
        for (let i = start; i < end; i++) {
          if (fmt.bold) flags[i].bold = true;
          if (fmt.italic) flags[i].italic = true;
          if (fmt.underline) flags[i].underline = true;
          if (fmt.link) flags[i].link = String(fmt.link);
        }
      }
      const escapeAttr = value => escapeHtml(value).replace(/"/g, "&quot;");
      let html = "";
      let prev = {};
      for (let i = 0; i < text.length; i++) {
        const cur = flags[i];
        const linkChanged = (prev.link || "") !== cur.link;
        if (prev.underline && (!cur.underline || linkChanged)) html += "</u>";
        if (prev.italic && (!cur.italic || linkChanged)) html += "</em>";
        if (prev.bold && (!cur.bold || linkChanged)) html += "</strong>";
        if (linkChanged && prev.link) html += "</a>";
        if (linkChanged && cur.link) html += "<a href=\"" + escapeAttr(cur.link) + "\">";
        if ((!prev.bold || linkChanged) && cur.bold) html += "<strong>";
        if ((!prev.italic || linkChanged) && cur.italic) html += "<em>";
        if ((!prev.underline || linkChanged) && cur.underline) html += "<u>";
        html += text[i] === "\n" ? "\n" : escapeHtml(text[i]);
        prev = cur;
      }
      if (prev.underline) html += "</u>";
      if (prev.italic) html += "</em>";
      if (prev.bold) html += "</strong>";
      if (prev.link) html += "</a>";
      $("editor").innerHTML = html;
    }
    function collectFormats() {
      const root = $("editor");
      const formats = [];
      let offset = 0;
      function flagsFor(node) {
        let el = node.parentElement;
        const flags = { bold: false, italic: false, underline: false, link: "" };
        while (el && el !== root) {
          const tag = el.tagName;
          const style = getComputedStyle(el);
          if (tag === "B" || tag === "STRONG" || Number(style.fontWeight) >= 600) flags.bold = true;
          if (tag === "I" || tag === "EM" || style.fontStyle === "italic") flags.italic = true;
          if (tag === "U" || (tag !== "A" && style.textDecorationLine.includes("underline"))) flags.underline = true;
          if (tag === "A" && el.getAttribute("href")) flags.link = el.getAttribute("href");
          el = el.parentElement;
        }
        return flags;
      }
      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.nodeValue || "";
          const flags = flagsFor(node);
          if (text.length && (flags.bold || flags.italic || flags.underline || flags.link)) {
            formats.push({ offset, length: text.length, ...flags });
          }
          offset += text.length;
          return;
        }
        if (node.nodeName === "BR") {
          offset += 1;
          return;
        }
        const addsBlockBreak = node.nodeType === Node.ELEMENT_NODE && (node.tagName === "DIV" || node.tagName === "P") && node.nextSibling;
        for (const child of node.childNodes) walk(child);
        if (addsBlockBreak) offset += 1;
      }
      walk(root);
      return formats;
    }
    function markdownEscape(text) {
      const specials = new RegExp("([_*\\[\\]()~" + String.fromCharCode(96) + ">#+\\-=|{}.!\\\\])", "g");
      return String(text ?? "").replace(specials, "\\$1");
    }
    function markdownCodeEscape(text) {
      return String(text ?? "").replace(new RegExp("([\\\\" + String.fromCharCode(96) + "])", "g"), "\\$1");
    }
    function markdownUrlEscape(text) {
      return String(text ?? "").replace(/([\\)])/g, "\\$1");
    }
    function isSafeHref(value) {
      return /^(https?:\/\/|mailto:)/i.test(String(value ?? "").trim());
    }
    function editorToTgMarkdown(root) {
      const backtick = String.fromCharCode(96);
      const fence = backtick.repeat(3);
      function withMarks(text, marks) {
        if (!text) return "";
        if (marks.strike) text = "~" + text + "~";
        if (marks.spoiler) text = "||" + text + "||";
        if (marks.underline) text = "__" + text + "__";
        if (marks.italic) text = "_" + text + "_";
        if (marks.bold) text = "*" + text + "*";
        return text;
      }
      function styleHasLineThrough(style) {
        return style.textDecorationLine.includes("line-through") || style.textDecoration.includes("line-through");
      }
      function styleHasUnderline(style) {
        return style.textDecorationLine.includes("underline") || style.textDecoration.includes("underline");
      }
      function walkChildren(node, marks) {
        return [...node.childNodes].map(child => walk(child, marks)).join("");
      }
      function walk(node, marks = {}) {
        if (node.nodeType === Node.TEXT_NODE) {
          return withMarks(markdownEscape(node.nodeValue), marks);
        }
        if (node.nodeName === "BR") return "\n";
        const next = { ...marks };
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName;
          const style = getComputedStyle(node);
          if (tag === "CODE") return backtick + markdownCodeEscape(node.textContent) + backtick;
          if (tag === "PRE") return fence + "\n" + markdownCodeEscape(node.textContent).replace(/\n+$/, "") + "\n" + fence;
          if (tag === "A" && node.getAttribute("href")) {
            const href = node.getAttribute("href");
            const label = walkChildren(node, next);
            return isSafeHref(href) ? "[" + label + "](" + markdownUrlEscape(href.trim()) + ")" : label;
          }
          if (tag === "B" || tag === "STRONG" || Number(style.fontWeight) >= 600) next.bold = true;
          if (tag === "I" || tag === "EM" || style.fontStyle === "italic") next.italic = true;
          if (tag === "U" || styleHasUnderline(style)) next.underline = true;
          if (tag === "S" || tag === "STRIKE" || tag === "DEL" || styleHasLineThrough(style)) next.strike = true;
          if (node.classList.contains("tg-spoiler")) next.spoiler = true;
          if (tag === "BLOCKQUOTE") {
            const inner = walkChildren(node, next).replace(/\n+$/, "");
            const quote = inner
              .split("\n")
              .map(line => line ? ">" + line : "")
              .join("\n");
            return quote + "\n";
          }
          if (tag === "DIV" || tag === "P") {
            return walkChildren(node, next) + "\n";
          }
        }
        return walkChildren(node, next);
      }
      return walk(root).replace(/\n{3,}/g, "\n\n").replace(/\n$/, "");
    }
    function unescapeMarkdownV2(text) {
      const specials = new RegExp("\\\\([_*\\[\\]()~" + String.fromCharCode(96) + ">#+\\-=|{}.!\\\\])", "g");
      return String(text ?? "").replace(specials, "$1");
    }
    function tgMarkdownToHtml(text) {
      const backtick = String.fromCharCode(96);
      const fence = backtick.repeat(3);
      const tokenHtml = [];
      const escapeAttr = value => escapeHtml(String(value ?? "")).replace(/"/g, "&quot;");
      const stashHtml = html => {
        const token = "\u0000TGHTML" + tokenHtml.length + "\u0000";
        tokenHtml.push(html);
        return token;
      };
      const restoreHtml = html => html.replace(/\u0000TGHTML(\d+)\u0000/g, (_, index) => tokenHtml[Number(index)] || "");

      let markdown = String(text ?? "").replace(new RegExp(fence + "([\\s\\S]*?)" + fence, "g"), (_, code) => {
        return stashHtml("<pre>" + escapeHtml(unescapeMarkdownV2(code).replace(/^\n|\n$/g, "")) + "</pre>");
      });
      markdown = markdown.replace(new RegExp(backtick + "((?:\\\\.|[^" + backtick + "\\n])*)" + backtick, "g"), (_, code) => {
        return stashHtml("<code>" + escapeHtml(unescapeMarkdownV2(code)) + "</code>");
      });
      markdown = markdown.replace(/\[((?:\\.|[^\]\\\n])*)\]\(((?:\\.|[^)\\\n])*)\)/g, (_, label, url) => {
        const linkLabel = unescapeMarkdownV2(label);
        const linkUrl = unescapeMarkdownV2(url).trim();
        if (!isSafeHref(linkUrl)) {
          return stashHtml(escapeHtml("[" + linkLabel + "](" + linkUrl + ")"));
        }
        return stashHtml("<a href=\"" + escapeAttr(linkUrl) + "\">" + escapeHtml(linkLabel) + "</a>");
      });
      const escapedSpecials = new RegExp("\\\\([_*\\[\\]()~" + backtick + ">#+\\-=|{}.!\\\\])", "g");
      markdown = markdown.replace(escapedSpecials, (_, value) => {
        return stashHtml(escapeHtml(value));
      });

      let html = escapeHtml(markdown);
      html = html.replace(/(^|\n)((?:&gt; ?[^\n]*(?:\n|$))+)/g, (_, lead, body) => {
        const trailing = body.endsWith("\n") ? "\n" : "";
        const quote = body.replace(/\n$/, "").split("\n").map(line => line.replace(/^&gt; ?/, "")).join("\n");
        return lead + "<blockquote>" + quote + "</blockquote>" + trailing;
      });
      html = html.replace(/\|\|([^|\n]+)\|\|/g, "<span class=\"tg-spoiler\">$1</span>");
      html = html.replace(/~([^~\n]+)~/g, "<s>$1</s>");
      html = html.replace(/__([^_\n]+)__/g, "<u>$1</u>");
      html = html.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
      html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");
      return restoreHtml(html.replace(/\n/g, "<br>"));
    }
    function formData() {
      return {
        name: $("name").value,
        sendDate: fromDateTimeLocal($("sendDate").value),
        subscriptionFrom: $("subscriptionFrom").value,
        imagePath: $("imagePath").value,
        boldPhrases: [],
        message: $("editor").innerText.replace(/\n$/, ""),
        formats: collectFormats()
      };
    }
    function salebotData() {
      return {
        name: $("sbName").value,
        sendDate: fromDateTimeLocal($("sbSendDate").value),
        sheetUrl: saleBotSheetUrl,
        projectId: saleBotProjectId,
        sheetId: saleBotSheetId,
        comment: "",
        message: editorToTgMarkdown($("sbEditor")),
        buttonText: $("sbButtonText").value,
        buttonUrl: $("sbButtonUrl").value,
        buttonType: "inline",
        imagePath: $("sbImagePath").value,
        imageUrl: "",
        selectedAudienceIds: selectedSaleBotAudienceIds(),
        selectedAudiences: salebotAudiences.filter(a => selectedSaleBotAudienceIds().includes(a.id)),
        audience: {}
      };
    }
    function parseGroupIds(text) {
      return String(text || "")
        .split(/\r?\n|,|;/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => (x.match(/(\d+)(?:\D*)$/) || [null, x])[1])
        .filter(Boolean);
    }
    function renderSenlerGroups(data) {
      const groups = data?.groups || {};
      $("groupEge").value = (groups.ege || []).join("\n");
      $("groupOge").value = (groups.oge || []).join("\n");
      $("groupCommon").value = (groups.common || []).join("\n");
    }
    function senlerGroupsData() {
      return {
        groups: {
          ege: parseGroupIds($("groupEge").value),
          oge: parseGroupIds($("groupOge").value),
          common: parseGroupIds($("groupCommon").value)
        }
      };
    }
    async function api(path, data) {
      const res = await fetch(path, { method: data ? "POST" : "GET", headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Ошибка");
      return json;
    }
    async function save() {
      const json = await api("/api/campaign", formData());
      log("Кампания сохранена: " + json.file);
    }
    async function saveSalebot() {
      const json = await api("/api/salebot-campaign", salebotData());
      log("SaleBot сохранён: " + json.file);
    }
    async function salebotCommand(cmd) {
      await saveSalebot();
      log("Выполняю SaleBot...");
      const json = await api("/api/salebot-run", { command: cmd });
      log(json.output || "Готово.");
    }
    async function command(cmd) {
      await save();
      log("Выполняю...");
      const json = await api("/api/run", { command: cmd, only: selectedGroups() });
      log(json.output || "Готово.");
    }
    $("save").onclick = () => save().catch(e => log(e.message));
    $("openTabs").onclick = () => command("open-tabs").catch(e => log(e.message));
    $("validate").onclick = () => command("validate").catch(e => log(e.message));
    $("run").onclick = async () => {
      if (!confirm("Создать и активировать рассылки в выбранных группах?")) return;
      command("run").catch(e => log(e.message));
    };
    $("groupsReload").onclick = async () => {
      const json = await api("/api/senler-groups");
      renderSenlerGroups(json.groups);
      log("Список сообществ обновлён из файла.");
    };
    $("groupsSave").onclick = async () => {
      const json = await api("/api/senler-groups", senlerGroupsData());
      log("Сообщества сохранены: " + json.file);
    };
    $("sbSave").onclick = () => saveSalebot().catch(e => log(e.message));
    $("sbOpen").onclick = () => salebotCommand("open").catch(e => log(e.message));
    $("sbInspect").onclick = () => salebotCommand("inspect").catch(e => log(e.message));
    $("sbRunFinal").onclick = async () => {
      const command = $("sbFinalAction").value;
      const confirmText = {
        "create-blocks": "Создать комментарий и текстовый блок в SaleBot?",
        "create-drafts": "Создать блоки и черновики рассылок в SaleBot?",
        "schedule": "Создать блоки и запланировать рассылки в SaleBot?"
      }[command] || "Выполнить выбранное действие в SaleBot?";
      if (!confirm(confirmText)) return;
      salebotCommand(command).catch(e => log(e.message));
    };
    async function saveAudiences() {
      return api("/api/salebot-audiences", { audiences: salebotAudiences });
    }
    function slugAudienceId(name) {
      return name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, "_").replace(/^_+|_+$/g, "") || String(Date.now());
    }
    function clearAudienceEditor() {
      $("audSelect").value = "";
      $("audName").value = "";
      $("audBot").value = "";
      $("audTags").value = "";
    }
    function loadAudienceEditor(id) {
      const audience = salebotAudiences.find(a => a.id === id);
      if (!audience) return clearAudienceEditor();
      $("audSelect").value = audience.id;
      $("audName").value = audience.name || "";
      $("audBot").value = audience.bot || "";
      $("audTags").value = (audience.tags || [audience.tag].filter(Boolean)).join("\n");
    }
    function renderAudienceEditorOptions() {
      $("audSelect").innerHTML = "<option value=\"\">Новая аудитория</option>" + salebotAudiences
        .map(a => "<option value=\"" + escapeHtml(a.id) + "\">" + escapeHtml(a.name || a.id) + "</option>")
        .join("");
    }
    function addAudienceFromEditor() {
      const name = $("audName").value.trim();
      if (!name) return null;
      const currentId = $("audSelect").value;
      const id = currentId || slugAudienceId(name);
      const audience = {
        id,
        name,
        bot: $("audBot").value.trim(),
        tags: $("audTags").value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
      };
      salebotAudiences = salebotAudiences.filter(a => a.id !== id).concat(audience);
      renderAudienceEditorOptions();
      $("audSelect").value = id;
      return id;
    }
    $("audSelect").onchange = () => loadAudienceEditor($("audSelect").value);
    $("audNew").onclick = () => clearAudienceEditor();
    $("audAdd").onclick = async () => {
      const id = addAudienceFromEditor();
      if (!id) return log("Укажи название аудитории.");
      renderSaleBotAudiences(selectedSaleBotAudienceIds().concat(id));
      const json = await saveAudiences();
      log("Аудитория сохранена: " + json.file);
    };
    $("audDelete").onclick = async () => {
      const selected = new Set(selectedSaleBotAudienceIds());
      salebotAudiences = salebotAudiences.filter(a => !selected.has(a.id));
      renderSaleBotAudiences([]);
      renderAudienceEditorOptions();
      clearAudienceEditor();
      const json = await saveAudiences();
      log("Аудитории удалены и сохранены: " + json.file);
    };
    $("audSave").onclick = async () => {
      const addedId = addAudienceFromEditor();
      if (addedId) renderSaleBotAudiences(selectedSaleBotAudienceIds().concat(addedId));
      const json = await saveAudiences();
      log("Аудитории сохранены: " + json.file);
    };
    $("showLog").onclick = async () => {
      const json = await api("/api/log");
      log(json.log || "Лог пуст.");
    };
    $("sbShowLog").onclick = async () => {
      const json = await api("/api/log");
      log(json.log || "Лог пуст.");
    };
    $("clearLog").onclick = async () => {
      await api("/api/log/clear", {});
      log("Лог очищен.");
    };
    $("sbClearLog").onclick = async () => {
      await api("/api/log/clear", {});
      log("Лог очищен.");
    };
    $("imageFile").onchange = async () => {
      const file = $("imageFile").files[0];
      if (!file) return;
      log("Загружаю картинку...");
      const res = await fetch("/api/upload-image", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name) },
        body: await file.arrayBuffer()
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Не удалось загрузить картинку");
      $("imagePath").value = json.path;
      log("Картинка выбрана: " + json.path);
    };
    $("sbImageFile").onchange = async () => {
      const file = $("sbImageFile").files[0];
      if (!file) return;
      log("Загружаю картинку SaleBot...");
      const res = await fetch("/api/upload-image", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name) },
        body: await file.arrayBuffer()
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Не удалось загрузить картинку");
      $("sbImagePath").value = json.path;
      log("Картинка SaleBot выбрана: " + json.path);
    };
    api("/api/campaign").then(({ campaign }) => {
      $("name").value = campaign.name || "";
      $("sendDate").value = toDateTimeLocal(campaign.sendDate || "");
      $("subscriptionFrom").value = campaign.subscriptionFrom || "";
      $("imagePath").value = campaign.imagePath || "";
      renderEditor(campaign.message || "", campaign.formats || []);
    }).catch(e => log(e.message));
    api("/api/senler-groups").then(({ groups }) => {
      renderSenlerGroups(groups);
    }).catch(e => log(e.message));
    let salebotAudiences = [];
    let selectedSaleBotAudiencesFromCampaign = [];
    function renderSaleBotAudiences(selected = []) {
      renderAudienceEditorOptions();
      $("sbAudiences").innerHTML = salebotAudiences.map(a => {
        const checked = selected.includes(a.id) ? "checked" : "";
        return "<div class=\"check\"><label><input type=\"checkbox\" value=\"" + escapeHtml(a.id) + "\" " + checked + "> " + escapeHtml(a.name) + "</label> <button type=\"button\" data-aud-edit=\"" + escapeHtml(a.id) + "\">Править</button></div>";
      }).join("");
      document.querySelectorAll("[data-aud-edit]").forEach(btn => {
        btn.onclick = () => {
          loadAudienceEditor(btn.dataset.audEdit);
          activateTab("audiences");
        };
      });
    }
    api("/api/salebot-audiences").then(({ audiences }) => {
      salebotAudiences = audiences || [];
      renderSaleBotAudiences(selectedSaleBotAudiencesFromCampaign);
    }).catch(e => log(e.message));
    api("/api/salebot-campaign").then(({ campaign }) => {
      $("sbName").value = campaign.name || "";
      $("sbSendDate").value = toDateTimeLocal(campaign.sendDate || "");
      $("sbEditor").innerHTML = tgMarkdownToHtml(campaign.message || "");
      $("sbButtonText").value = campaign.buttonText || "";
      $("sbButtonUrl").value = campaign.buttonUrl || "";
      $("sbImagePath").value = campaign.imagePath || "";
      selectedSaleBotAudiencesFromCampaign = campaign.selectedAudienceIds || [];
      renderSaleBotAudiences(selectedSaleBotAudiencesFromCampaign);
    }).catch(e => log(e.message));
    function currentSelectionText() {
      const selection = window.getSelection();
      return selection ? selection.toString() : "";
    }
    function focusEditorById(id) {
      const editor = $(id);
      if (editor) editor.focus();
      return editor;
    }
    const savedEditorRanges = {};
    function rangeBelongsToEditor(range, editor) {
      if (!range || !editor) return false;
      const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      return editor.contains(container) || editor === container;
    }
    function rememberEditorSelection(editorId) {
      const editor = $(editorId);
      const selection = window.getSelection();
      if (!editor || !selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (rangeBelongsToEditor(range, editor)) savedEditorRanges[editorId] = range.cloneRange();
    }
    function restoreEditorSelection(editorId) {
      const editor = $(editorId);
      const range = savedEditorRanges[editorId];
      if (!editor || !range || !rangeBelongsToEditor(range, editor)) return null;
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range.cloneRange());
      return selection.getRangeAt(0);
    }
    function selectedRangeInEditor(editor) {
      const selection = window.getSelection();
      if (!editor) return null;
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        if (rangeBelongsToEditor(range, editor)) {
          savedEditorRanges[editor.id] = range.cloneRange();
          return range;
        }
      }
      return restoreEditorSelection(editor.id);
    }
    function notifyEditorInput(editor) {
      if (editor) editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function applyInlineWrapper(editorId, tagName, className = "") {
      const editor = focusEditorById(editorId);
      const range = selectedRangeInEditor(editor);
      if (!range) return;
      const node = document.createElement(tagName);
      if (className) node.className = className;
      if (range.collapsed) {
        node.textContent = currentSelectionText() || tagName.toLowerCase();
      } else {
        node.appendChild(range.extractContents());
      }
      range.deleteContents();
      range.insertNode(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      const nextRange = document.createRange();
      nextRange.selectNodeContents(node);
      nextRange.collapse(false);
      selection.addRange(nextRange);
      editor.focus();
      savedEditorRanges[editorId] = nextRange.cloneRange();
      notifyEditorInput(editor);
    }
    function applyBlockWrapper(editorId, tagName) {
      const editor = focusEditorById(editorId);
      const range = selectedRangeInEditor(editor);
      if (!range) return;
      const node = document.createElement(tagName);
      if (range.collapsed) {
        node.appendChild(document.createElement("br"));
      } else {
        node.appendChild(range.extractContents());
      }
      range.deleteContents();
      range.insertNode(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      const nextRange = document.createRange();
      nextRange.selectNodeContents(node);
      nextRange.collapse(false);
      selection.addRange(nextRange);
      editor.focus();
      savedEditorRanges[editorId] = nextRange.cloneRange();
      notifyEditorInput(editor);
    }
    function applyLink(editorId) {
      const editor = focusEditorById(editorId);
      const range = selectedRangeInEditor(editor);
      if (!range) return;
      const url = prompt("Ссылка");
      if (!url) return;
      const link = document.createElement("a");
      link.href = url.trim();
      link.target = "_blank";
      link.rel = "noreferrer";
      if (range.collapsed) {
        link.textContent = currentSelectionText() || url.trim();
      } else {
        link.appendChild(range.extractContents());
      }
      range.deleteContents();
      range.insertNode(link);
      const selection = window.getSelection();
      selection.removeAllRanges();
      const nextRange = document.createRange();
      nextRange.selectNodeContents(link);
      nextRange.collapse(false);
      selection.addRange(nextRange);
      editor.focus();
      savedEditorRanges[editorId] = nextRange.cloneRange();
      notifyEditorInput(editor);
    }
    function insertTextAtCaret(editorId, text) {
      const editor = focusEditorById(editorId);
      const selection = window.getSelection();
      let range = selectedRangeInEditor(editor);
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      editor.focus();
      savedEditorRanges[editorId] = range.cloneRange();
      notifyEditorInput(editor);
    }
    ["editor", "sbEditor"].forEach(editorId => {
      const editor = $(editorId);
      editor.addEventListener("keyup", () => rememberEditorSelection(editorId));
      editor.addEventListener("mouseup", () => rememberEditorSelection(editorId));
      editor.addEventListener("input", () => rememberEditorSelection(editorId));
    });
    document.addEventListener("selectionchange", () => {
      rememberEditorSelection("editor");
      rememberEditorSelection("sbEditor");
    });
    document.querySelectorAll(".toolbar button").forEach(btn => {
      btn.onmousedown = (event) => event.preventDefault();
      btn.onclick = () => {
        const editorId = btn.dataset.editor || "editor";
        focusEditorById(editorId);
        if (btn.hasAttribute("data-format-link")) return applyLink(editorId);
        if (btn.hasAttribute("data-inline-code")) return applyInlineWrapper(editorId, "code");
        if (btn.hasAttribute("data-code-block")) return applyBlockWrapper(editorId, "pre");
        if (btn.hasAttribute("data-spoiler")) return applyInlineWrapper(editorId, "span", "tg-spoiler");
        if (btn.hasAttribute("data-quote")) return applyBlockWrapper(editorId, "blockquote");
        if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd, false, null);
      };
    });
    $("senlerVariable").onchange = () => {
      let value = $("senlerVariable").value;
      $("senlerVariable").value = "";
      if (!value) return;
      if (value === "__custom_user__" || value === "__custom_global__") {
        const name = String(prompt("Имя переменной") || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
        if (!name) return;
        value = value === "__custom_user__" ? "{%" + name + "%}" : "[%" + name + "%]";
      }
      insertTextAtCaret("editor", value);
    };
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, page, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/live-reload") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      });
      res.write("event: ready\ndata: ok\n\n");
      const interval = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => clearInterval(interval));
      return;
    }
    await appendLog("request", { method: req.method, path: url.pathname });
    if (req.method === "GET" && url.pathname === "/api/campaign") {
      const file = (await exists(CAMPAIGN_FILE)) ? CAMPAIGN_FILE : EXAMPLE_FILE;
      return send(res, 200, JSON.stringify({ campaign: await readJson(file), file }));
    }
    if (req.method === "POST" && url.pathname === "/api/campaign") {
      const data = JSON.parse(await getBody(req));
      await fs.writeFile(CAMPAIGN_FILE, JSON.stringify(data, null, 2), "utf8");
      await appendLog("campaign.save", { file: CAMPAIGN_FILE, name: data.name, sendDate: data.sendDate });
      return send(res, 200, JSON.stringify({ ok: true, file: CAMPAIGN_FILE }));
    }
    if (req.method === "GET" && url.pathname === "/api/senler-groups") {
      const groups = (await exists(SENLER_GROUPS_FILE)) ? await readJson(SENLER_GROUPS_FILE) : { groups: { ege: [], oge: [], common: [] } };
      return send(res, 200, JSON.stringify({ groups, file: SENLER_GROUPS_FILE }));
    }
    if (req.method === "POST" && url.pathname === "/api/senler-groups") {
      const data = JSON.parse(await getBody(req));
      const current = (await exists(SENLER_GROUPS_FILE)) ? await readJson(SENLER_GROUPS_FILE) : {};
      const clean = (items) => [...new Set((items || []).map(x => String(x).trim()).filter(Boolean))];
      const next = {
        ...current,
        groups: {
          ege: clean(data.groups?.ege),
          oge: clean(data.groups?.oge),
          common: clean(data.groups?.common)
        }
      };
      await fs.mkdir(path.dirname(SENLER_GROUPS_FILE), { recursive: true });
      await fs.writeFile(SENLER_GROUPS_FILE, JSON.stringify(next, null, 2), "utf8");
      await appendLog("senler.groups.save", { file: SENLER_GROUPS_FILE, count: Object.values(next.groups).flat().length });
      return send(res, 200, JSON.stringify({ ok: true, file: SENLER_GROUPS_FILE, groups: next }));
    }
    if (req.method === "GET" && url.pathname === "/api/salebot-campaign") {
      const file = (await exists(SALEBOT_CAMPAIGN_FILE)) ? SALEBOT_CAMPAIGN_FILE : SALEBOT_EXAMPLE_FILE;
      return send(res, 200, JSON.stringify({ campaign: await readJson(file), file }));
    }
    if (req.method === "POST" && url.pathname === "/api/salebot-campaign") {
      const data = JSON.parse(await getBody(req));
      await fs.mkdir(path.dirname(SALEBOT_CAMPAIGN_FILE), { recursive: true });
      await fs.writeFile(SALEBOT_CAMPAIGN_FILE, JSON.stringify(data, null, 2), "utf8");
      await appendLog("salebot.campaign.save", { file: SALEBOT_CAMPAIGN_FILE, name: data.name, sendDate: data.sendDate });
      return send(res, 200, JSON.stringify({ ok: true, file: SALEBOT_CAMPAIGN_FILE }));
    }
    if (req.method === "GET" && url.pathname === "/api/salebot-audiences") {
      const audiences = (await exists(SALEBOT_AUDIENCES_FILE)) ? await readJson(SALEBOT_AUDIENCES_FILE) : [];
      return send(res, 200, JSON.stringify({ audiences, file: SALEBOT_AUDIENCES_FILE }));
    }
    if (req.method === "POST" && url.pathname === "/api/salebot-audiences") {
      const data = JSON.parse(await getBody(req));
      await fs.mkdir(path.dirname(SALEBOT_AUDIENCES_FILE), { recursive: true });
      await fs.writeFile(SALEBOT_AUDIENCES_FILE, JSON.stringify(data.audiences || [], null, 2), "utf8");
      await appendLog("salebot.audiences.save", { file: SALEBOT_AUDIENCES_FILE, count: (data.audiences || []).length });
      return send(res, 200, JSON.stringify({ ok: true, file: SALEBOT_AUDIENCES_FILE }));
    }
    if (req.method === "POST" && url.pathname === "/api/upload-image") {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      const rawName = decodeURIComponent(req.headers["x-filename"] || "image.png");
      const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
      const ext = path.extname(safeName) || ".png";
      const base = path.basename(safeName, ext).slice(0, 80) || "image";
      const file = path.join(UPLOAD_DIR, `${Date.now()}-${base}${ext}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await fs.writeFile(file, Buffer.concat(chunks));
      await appendLog("image.upload", { file });
      return send(res, 200, JSON.stringify({ ok: true, path: file }));
    }
    if (req.method === "GET" && url.pathname === "/api/log") {
      const log = (await exists(LOG_FILE)) ? await fs.readFile(LOG_FILE, "utf8") : "";
      return send(res, 200, JSON.stringify({ file: LOG_FILE, log: log.split(/\r?\n/).slice(-250).join("\n") }));
    }
    if (req.method === "POST" && url.pathname === "/api/log/clear") {
      await fs.mkdir(LOG_DIR, { recursive: true });
      await fs.writeFile(LOG_FILE, "", "utf8");
      await appendLog("log.clear");
      return send(res, 200, JSON.stringify({ ok: true, file: LOG_FILE }));
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const data = JSON.parse(await getBody(req));
      const allowed = new Set(["open-tabs", "validate", "run"]);
      if (!allowed.has(data.command)) return send(res, 400, JSON.stringify({ error: "bad command" }));
      const args = [data.command, "--campaign", "senler/campaign.ui.json"];
      if (data.only) args.push("--only", data.only);
      if (data.command === "run") args.push("--confirm-send");
      await appendLog("command.start", { command: data.command, only: data.only || "", args });
      const result = await runSenler(args);
      return send(res, result.code === 0 ? 200 : 500, JSON.stringify(result));
    }
    if (req.method === "POST" && url.pathname === "/api/salebot-run") {
      const data = JSON.parse(await getBody(req));
      const allowed = new Set(["open", "inspect", "create-blocks", "create-drafts", "schedule"]);
      if (!allowed.has(data.command)) return send(res, 400, JSON.stringify({ error: "bad salebot command" }));
      const args = [data.command, "--campaign", "salebot/campaign.ui.json"];
      if (data.command === "create-blocks" || data.command === "create-drafts" || data.command === "schedule") args.push("--confirm-create");
      if (data.command === "schedule") args.push("--confirm-schedule");
      await appendLog("salebot.start", { command: data.command, args });
      const result = await runSalebot(args);
      return send(res, result.code === 0 ? 200 : 500, JSON.stringify(result));
    }
    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (err) {
    await appendLog("error", { path: req.url, error: err.stack || err.message }).catch(() => {});
    return send(res, 500, JSON.stringify({ error: err.stack || err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Senler UI: http://127.0.0.1:${PORT}/`);
});

