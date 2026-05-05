# Rich Editor Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add platform-appropriate rich text controls for Senler and SaleBot / Telegram, including links, Telegram MarkdownV2 formatting, and Senler variables.

**Architecture:** Keep the existing single-file local UI, but extract MarkdownV2 escaping into a tiny shared module so it can be unit tested. Senler continues to save `message + formats`; Telegram continues to save MarkdownV2 in `message`.

**Tech Stack:** Node.js ESM, built-in `node:test`, local HTTP server in `scripts/senler-ui.mjs`, Quill automation through Chrome DevTools Protocol.

---

## File Structure

- Modify `package.json`: add a `test` script that runs focused Node tests.
- Create `scripts/lib/markdown-v2.mjs`: pure MarkdownV2 escaping helpers used by tests and mirrored by the browser UI.
- Create `scripts/lib/markdown-v2.test.mjs`: unit tests for MarkdownV2 escaping and URL escaping.
- Modify `scripts/senler-ui.mjs`: add toolbar buttons, link insertion, variable insertion, Senler link format collection/rendering, Telegram MarkdownV2 serialization, and MarkdownV2 draft loading.
- Modify `scripts/senler-tool.mjs`: apply saved Senler link ranges to Quill.

---

### Task 1: Add MarkdownV2 Helper Tests

**Files:**
- Modify: `package.json`
- Create: `scripts/lib/markdown-v2.mjs`
- Create: `scripts/lib/markdown-v2.test.mjs`

- [ ] **Step 1: Add the test command**

Edit `package.json` scripts so it contains:

```json
{
  "scripts": {
    "senler": "node scripts/senler-tool.mjs",
    "salebot": "node scripts/salebot-tool.mjs",
    "senler-ui": "node scripts/senler-ui.mjs",
    "senler-ui:dev": "node --watch scripts/senler-ui.mjs",
    "test": "node --test scripts/lib/*.test.mjs"
  }
}
```

- [ ] **Step 2: Create the failing tests**

Create `scripts/lib/markdown-v2.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { escapeMarkdownV2, escapeMarkdownV2Code, escapeMarkdownV2Url } from "./markdown-v2.mjs";

test("escapeMarkdownV2 escapes Telegram MarkdownV2 special characters", () => {
  assert.equal(
    escapeMarkdownV2("a_b *x* [t](u) ~ ` > # + - = | { } . ! \\"),
    "a\\_b \\*x\\* \\[t\\]\\(u\\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\"
  );
});

test("escapeMarkdownV2Code escapes backticks and backslashes only", () => {
  assert.equal(escapeMarkdownV2Code("const x = `a\\b`;"), "const x = \\`a\\\\b\\`;");
});

test("escapeMarkdownV2Url escapes link destination delimiters", () => {
  assert.equal(escapeMarkdownV2Url("https://example.com/a)b\\c"), "https://example.com/a\\)b\\\\c");
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```powershell
npm test
```

Expected: FAIL because `scripts/lib/markdown-v2.mjs` does not exist yet.

- [ ] **Step 4: Implement the helper module**

Create `scripts/lib/markdown-v2.mjs`:

```js
const MARKDOWN_V2_SPECIALS = /([_*[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(value) {
  return String(value || "").replace(/\\+([.!])/g, "$1").replace(MARKDOWN_V2_SPECIALS, "\\$1");
}

export function escapeMarkdownV2Code(value) {
  return String(value || "").replace(/[\\`]/g, "\\$&");
}

export function escapeMarkdownV2Url(value) {
  return String(value || "").replace(/[\\)]/g, "\\$&");
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```powershell
npm test
```

Expected: PASS for all three tests.

- [ ] **Step 6: Commit when Git permissions allow it**

Run:

```powershell
git add package.json scripts/lib/markdown-v2.mjs scripts/lib/markdown-v2.test.mjs
git commit -m "test: add markdown v2 escaping helpers"
```

Expected: commit succeeds. If `.git/index.lock` is still denied by Windows ACL, keep the files unstaged and continue.

---

### Task 2: Add Toolbar Controls And Editor Commands

**Files:**
- Modify: `scripts/senler-ui.mjs`

- [ ] **Step 1: Add toolbar CSS for selects and links**

In the embedded `<style>` near the existing `.toolbar` rules, replace:

```css
.toolbar { display: flex; gap: 6px; align-items: center; border: 1px solid #c7d0dc; border-bottom: 0; border-radius: 6px 6px 0 0; padding: 8px; background: #f8fafc; }
.toolbar button { min-width: 36px; height: 34px; padding: 0; border: 1px solid #c7d0dc; background: #fff; }
.toolbar button.active { background: #dbeafe; border-color: #60a5fa; }
```

with:

```css
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid #c7d0dc; border-bottom: 0; border-radius: 6px 6px 0 0; padding: 8px; background: #f8fafc; }
.toolbar button { min-width: 36px; height: 34px; padding: 0 8px; border: 1px solid #c7d0dc; background: #fff; }
.toolbar button.active { background: #dbeafe; border-color: #60a5fa; }
.toolbar select { width: auto; min-width: 170px; height: 34px; padding: 6px 28px 6px 8px; font-size: 13px; }
#editor a, #sbEditor a { color: #1d4ed8; text-decoration: underline; }
#editor code, #sbEditor code { font-family: Consolas, Menlo, monospace; background: #eef2f7; border-radius: 4px; padding: 1px 4px; }
#sbEditor pre { margin: 4px 0; padding: 8px; background: #eef2f7; color: #17202a; border-radius: 6px; white-space: pre-wrap; }
.tg-spoiler { background: #d8dee6; border-radius: 4px; padding: 0 3px; }
blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid #9aa7b6; color: #374151; }
```

- [ ] **Step 2: Expand the Senler toolbar markup**

Replace the Senler toolbar:

```html
<div class="toolbar" aria-label="Форматирование текста">
  <button type="button" data-cmd="bold"><b>B</b></button>
  <button type="button" data-cmd="italic"><i>I</i></button>
  <button type="button" data-cmd="underline"><u>U</u></button>
</div>
```

with:

```html
<div class="toolbar" aria-label="Форматирование текста Senler">
  <button type="button" data-editor="editor" data-cmd="bold" title="Жирный"><b>B</b></button>
  <button type="button" data-editor="editor" data-cmd="italic" title="Курсив"><i>I</i></button>
  <button type="button" data-editor="editor" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
  <button type="button" data-editor="editor" data-format-link title="Ссылка">Link</button>
  <select id="senlerVariable" aria-label="Переменные Senler">
    <option value="">Переменные</option>
    <option value="%username%">Имя: %username%</option>
    <option value="%fullname%">Полное имя: %fullname%</option>
    <option value="%userid%">ID: %userid%</option>
    <option value="%domain%">Домен: %domain%</option>
    <option value="{%email%}">Email: {%email%}</option>
    <option value="[%var%]">Глобальная: [%var%]</option>
    <option value="[rand]текст 1|текст 2|текст 3[/rand]">Случайный текст</option>
    <option value="[date]%e %month|+1 day[/date]">Дата</option>
    <option value="__custom_user__">Своя {%var%}</option>
    <option value="__custom_global__">Своя [%var%]</option>
  </select>
</div>
```

- [ ] **Step 3: Expand the SaleBot / Telegram toolbar markup**

Replace the SaleBot toolbar:

```html
<div class="toolbar" aria-label="Форматирование текста SaleBot">
  <button type="button" data-sb-cmd="bold"><b>B</b></button>
  <button type="button" data-sb-cmd="italic"><i>I</i></button>
  <button type="button" data-sb-cmd="underline"><u>U</u></button>
</div>
```

with:

```html
<div class="toolbar" aria-label="Форматирование текста Telegram">
  <button type="button" data-editor="sbEditor" data-cmd="bold" title="Жирный"><b>B</b></button>
  <button type="button" data-editor="sbEditor" data-cmd="italic" title="Курсив"><i>I</i></button>
  <button type="button" data-editor="sbEditor" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
  <button type="button" data-editor="sbEditor" data-cmd="strikeThrough" title="Зачёркнутый"><s>S</s></button>
  <button type="button" data-editor="sbEditor" data-inline-code title="Моноширинный">Code</button>
  <button type="button" data-editor="sbEditor" data-code-block title="Блок кода">Pre</button>
  <button type="button" data-editor="sbEditor" data-spoiler title="Спойлер">Spoiler</button>
  <button type="button" data-editor="sbEditor" data-quote title="Цитата">Quote</button>
  <button type="button" data-editor="sbEditor" data-format-link title="Ссылка">Link</button>
</div>
```

- [ ] **Step 4: Add editor command helpers**

In the inline `<script>`, before current toolbar click handlers, add:

```js
function currentSelectionText() {
  return String(window.getSelection()?.toString() || "");
}

function focusEditorById(id) {
  const editor = $(id);
  editor.focus();
  return editor;
}

function applyInlineWrapper(editorId, tagName, className = "") {
  const editor = focusEditorById(editorId);
  const selected = currentSelectionText();
  if (!selected) return;
  const node = document.createElement(tagName);
  if (className) node.className = className;
  node.textContent = selected;
  document.execCommand("insertHTML", false, node.outerHTML);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyBlockWrapper(editorId, tagName) {
  const editor = focusEditorById(editorId);
  const selected = currentSelectionText();
  if (!selected) return;
  const node = document.createElement(tagName);
  node.textContent = selected;
  document.execCommand("insertHTML", false, node.outerHTML);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyLink(editorId) {
  const editor = focusEditorById(editorId);
  const selected = currentSelectionText();
  const url = prompt("Ссылка", selected && /^https?:\/\//i.test(selected) ? selected : "https://");
  if (!url) return;
  const label = selected || url;
  const a = document.createElement("a");
  a.href = url;
  a.textContent = label;
  document.execCommand("insertHTML", false, a.outerHTML);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertTextAtCaret(editorId, text) {
  const editor = focusEditorById(editorId);
  document.execCommand("insertText", false, text);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}
```

- [ ] **Step 5: Replace duplicate toolbar event handlers**

Replace the two existing toolbar handler blocks at the bottom of the script with:

```js
document.querySelectorAll(".toolbar button").forEach(btn => {
  btn.onclick = () => {
    const editorId = btn.dataset.editor || (btn.dataset.sbCmd ? "sbEditor" : "editor");
    if (btn.dataset.formatLink !== undefined) return applyLink(editorId);
    if (btn.dataset.inlineCode !== undefined) return applyInlineWrapper(editorId, "code");
    if (btn.dataset.codeBlock !== undefined) return applyBlockWrapper(editorId, "pre");
    if (btn.dataset.spoiler !== undefined) return applyInlineWrapper(editorId, "span", "tg-spoiler");
    if (btn.dataset.quote !== undefined) return applyBlockWrapper(editorId, "blockquote");
    focusEditorById(editorId);
    document.execCommand(btn.dataset.cmd || btn.dataset.sbCmd, false, null);
  };
});

$("senlerVariable").onchange = () => {
  const value = $("senlerVariable").value;
  $("senlerVariable").value = "";
  if (!value) return;
  if (value === "__custom_user__" || value === "__custom_global__") {
    const raw = prompt("Имя переменной: только латиница, цифры и подчёркивание", "");
    const name = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!name) return;
    insertTextAtCaret("editor", value === "__custom_user__" ? "{%" + name + "%}" : "[%" + name + "%]");
    return;
  }
  insertTextAtCaret("editor", value);
};
```

- [ ] **Step 6: Manually verify the toolbar**

Run:

```powershell
npm run senler-ui
```

Open `http://127.0.0.1:4317/`. Expected: both editors show the expanded toolbar; clicking buttons changes selected text; Senler variable select inserts text.

---

### Task 3: Preserve Senler Links In Local Campaign Data

**Files:**
- Modify: `scripts/senler-ui.mjs`

- [ ] **Step 1: Extend `renderEditor()` flags**

Inside `renderEditor(text, formats)`, change the flags initialization from:

```js
const flags = Array.from({ length: text.length }, () => ({ bold: false, italic: false, underline: false }));
```

to:

```js
const flags = Array.from({ length: text.length }, () => ({ bold: false, italic: false, underline: false, link: "" }));
```

In the loop applying `formats`, add:

```js
if (fmt.link) flags[i].link = String(fmt.link);
```

- [ ] **Step 2: Add link open/close behavior**

In the `renderEditor()` character loop, close and open tags in this order:

```js
if (prev.link && prev.link !== cur.link) html += "</a>";
if (prev.underline && !cur.underline) html += "</u>";
if (prev.italic && !cur.italic) html += "</em>";
if (prev.bold && !cur.bold) html += "</strong>";
if (!prev.bold && cur.bold) html += "<strong>";
if (!prev.italic && cur.italic) html += "<em>";
if (!prev.underline && cur.underline) html += "<u>";
if (cur.link && prev.link !== cur.link) html += "<a href=\"" + escapeHtml(cur.link).replace(/"/g, "&quot;") + "\">";
```

After the loop, close link before finishing:

```js
if (prev.link) html += "</a>";
```

- [ ] **Step 3: Extend `collectFormats()` to include links**

Change `flagsFor(node)` from:

```js
const flags = { bold: false, italic: false, underline: false };
```

to:

```js
const flags = { bold: false, italic: false, underline: false, link: "" };
```

Inside its ancestor loop, add:

```js
if (tag === "A" && el.getAttribute("href")) flags.link = el.getAttribute("href");
```

Change the push condition from:

```js
if (text.length && (flags.bold || flags.italic || flags.underline)) {
```

to:

```js
if (text.length && (flags.bold || flags.italic || flags.underline || flags.link)) {
```

- [ ] **Step 4: Verify JSON output**

Run the UI, create linked text in the Senler editor, click `Сохранить`, and inspect `senler/campaign.ui.json`.

Expected:

```json
{
  "message": "пример",
  "formats": [
    {
      "offset": 0,
      "length": 6,
      "bold": false,
      "italic": false,
      "underline": false,
      "link": "https://example.com"
    }
  ]
}
```

The exact offset and length may differ depending on surrounding text.

---

### Task 4: Generate Full Telegram MarkdownV2

**Files:**
- Modify: `scripts/senler-ui.mjs`

- [ ] **Step 1: Replace local Markdown escape helpers**

Replace current `markdownEscape(text)` with these browser-side helpers:

```js
function markdownEscape(text) {
  const specials = new RegExp("([_*\\[\\]()~" + String.fromCharCode(96) + ">#+\\-=|{}.!\\\\])", "g");
  return String(text || "").replace(/\\+([.!])/g, "$1").replace(specials, "\\$1");
}

function markdownCodeEscape(text) {
  return String(text || "").replace(/[\\`]/g, "\\$&");
}

function markdownUrlEscape(text) {
  return String(text || "").replace(/[\\)]/g, "\\$&");
}
```

- [ ] **Step 2: Replace `editorToTgMarkdown(root)`**

Replace the function with:

```js
function editorToTgMarkdown(root) {
  function children(node, marks = {}) {
    return [...node.childNodes].map(child => walk(child, marks)).join("");
  }

  function wrap(text, marks) {
    if (!text) return "";
    if (marks.code) return "`" + markdownCodeEscape(text) + "`";
    if (marks.spoiler) text = "||" + text + "||";
    if (marks.strike) text = "~" + text + "~";
    if (marks.underline) text = "__" + text + "__";
    if (marks.italic) text = "_" + text + "_";
    if (marks.bold) text = "*" + text + "*";
    return text;
  }

  function quote(text) {
    return text.split("\n").map(line => line ? ">" + line : ">").join("\n");
  }

  function walk(node, marks = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue || "";
      return wrap(markdownEscape(raw), marks);
    }
    if (node.nodeName === "BR") return "\n";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName;
    const style = getComputedStyle(node);
    const next = { ...marks };

    if (tag === "A") {
      const label = children(node, marks);
      const href = markdownUrlEscape(node.getAttribute("href") || "");
      return href ? "[" + label + "](" + href + ")" : label;
    }
    if (tag === "PRE") {
      const text = node.innerText.replace(/\n$/, "");
      return "```\n" + markdownCodeEscape(text) + "\n```";
    }
    if (tag === "CODE") next.code = true;
    if (tag === "B" || tag === "STRONG" || Number(style.fontWeight) >= 600) next.bold = true;
    if (tag === "I" || tag === "EM" || style.fontStyle === "italic") next.italic = true;
    if (tag === "U" || style.textDecorationLine.includes("underline")) next.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL" || style.textDecorationLine.includes("line-through")) next.strike = true;
    if (tag === "SPAN" && node.classList.contains("tg-spoiler")) next.spoiler = true;
    if (tag === "BLOCKQUOTE") return quote(children(node, next).replace(/\n$/, "")) + "\n";
    if (tag === "DIV" || tag === "P") return children(node, next) + "\n";
    return children(node, next);
  }

  return walk(root).replace(/\n{3,}/g, "\n\n").replace(/\n$/, "");
}
```

- [ ] **Step 3: Manual MarkdownV2 output check**

In the SaleBot editor, create:

```text
Жирный
Курсив
Подчёркнутый
Зачёркнутый
code
спойлер
цитата
ссылка
```

Apply each toolbar control, click `Сохранить`, and inspect `salebot/campaign.ui.json`.

Expected message contains these MarkdownV2 forms:

```text
*Жирный*
_Курсив_
__Подчёркнутый__
~Зачёркнутый~
`code`
||спойлер||
>цитата
[ссылка](https://example.com)
```

- [ ] **Step 4: Run unit tests**

Run:

```powershell
npm test
```

Expected: PASS.

---

### Task 5: Load Common MarkdownV2 Drafts Back Into The Editor

**Files:**
- Modify: `scripts/senler-ui.mjs`

- [ ] **Step 1: Replace `tgMarkdownToHtml(text)`**

Replace the current function with:

```js
function unescapeMarkdownV2(text) {
  return String(text || "").replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
}

function tgMarkdownToHtml(text) {
  let source = String(text || "");
  const blocks = [];
  source = source.replace(/```(?:[a-z0-9_-]+)?\n([\s\S]*?)```/gi, (_, code) => {
    const id = blocks.push("<pre>" + escapeHtml(unescapeMarkdownV2(code.replace(/\n$/, ""))) + "</pre>") - 1;
    return "\u0000BLOCK" + id + "\u0000";
  });
  source = escapeHtml(unescapeMarkdownV2(source));
  source = source.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
  source = source.replace(/\|\|([^|]+)\|\|/g, "<span class=\"tg-spoiler\">$1</span>");
  source = source.replace(/`([^`]+)`/g, "<code>$1</code>");
  source = source.replace(/~([^~]+)~/g, "<s>$1</s>");
  source = source.replace(/__([^_]+)__/g, "<u>$1</u>");
  source = source.replace(/\*([^*]+)\*/g, "<strong>$1</strong>");
  source = source.replace(/_([^_]+)_/g, "<em>$1</em>");
  source = source.replace(/^&gt;(.+)$/gm, "<blockquote>$1</blockquote>");
  source = source.replace(/\u0000BLOCK(\d+)\u0000/g, (_, id) => blocks[Number(id)] || "");
  return source.replace(/\n/g, "<br>");
}
```

- [ ] **Step 2: Verify backward compatibility**

Put this in `salebot/campaign.ui.json` message:

```text
*Привет*

Обычный текст
```

Reload the UI.

Expected: `Привет` appears bold in the SaleBot editor and ordinary text remains ordinary.

- [ ] **Step 3: Verify new draft loading**

Put this in `salebot/campaign.ui.json` message:

```text
[ссылка](https://example.com)
~зачёркнутый~
||спойлер||
`код`
```

Reload the UI.

Expected: link, strikethrough, spoiler, and inline code visually appear in the editor.

---

### Task 6: Apply Senler Links In Remote Quill

**Files:**
- Modify: `scripts/senler-tool.mjs`

- [ ] **Step 1: Add link support to Quill attrs**

Inside `fillEditor()`, find:

```js
if (fmt.bold) attrs.bold = true;
if (fmt.italic) attrs.italic = true;
if (fmt.underline) attrs.underline = true;
if (Object.keys(attrs).length) quill.formatText(offset, length, attrs, "user");
```

Replace it with:

```js
if (fmt.bold) attrs.bold = true;
if (fmt.italic) attrs.italic = true;
if (fmt.underline) attrs.underline = true;
if (fmt.link) attrs.link = String(fmt.link);
if (Object.keys(attrs).length) quill.formatText(offset, length, attrs, "user");
```

- [ ] **Step 2: Extend local formatted check**

In the return object inside `fillEditor()`, change:

```js
formatted: /<(strong|em|u)>/.test(editor?.innerHTML || "")
```

to:

```js
formatted: /<(strong|em|u|a)\b/.test(editor?.innerHTML || "")
```

- [ ] **Step 3: Verify with a local campaign**

Save a Senler campaign with linked text and run:

```powershell
npm run senler -- validate -- --campaign senler/campaign.ui.json --only ege
```

Expected: the command runs without local serialization errors. Full remote verification still depends on an authenticated Senler browser session.

---

### Task 7: Final Verification

**Files:**
- Verify: `package.json`
- Verify: `scripts/lib/markdown-v2.mjs`
- Verify: `scripts/lib/markdown-v2.test.mjs`
- Verify: `scripts/senler-ui.mjs`
- Verify: `scripts/senler-tool.mjs`

- [ ] **Step 1: Run automated tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 2: Check server startup**

Run:

```powershell
npm run senler-ui
```

Expected output includes:

```text
Senler UI: http://127.0.0.1:4317/
```

- [ ] **Step 3: Verify Senler save flow**

In the Senler tab:

- Add bold text.
- Add underlined text.
- Add linked text.
- Insert `%username%` from the variable menu.
- Click `Сохранить`.

Expected `senler/campaign.ui.json` includes plain variable text in `message` and `formats` ranges for bold, underline, and link.

- [ ] **Step 4: Verify SaleBot / Telegram save flow**

In the SaleBot / Telegram tab:

- Add bold, italic, underline, strikethrough, inline code, code block, spoiler, quote, and linked text.
- Click `Сохранить`.

Expected `salebot/campaign.ui.json` contains valid MarkdownV2 syntax and escaped punctuation.

- [ ] **Step 5: Review Git diff**

Run:

```powershell
git diff -- package.json scripts/lib/markdown-v2.mjs scripts/lib/markdown-v2.test.mjs scripts/senler-ui.mjs scripts/senler-tool.mjs
```

Expected: only the intended editor, helper, test, and Senler link automation changes are present. Existing unrelated UI edits remain untouched.

- [ ] **Step 6: Commit when Git permissions allow it**

Run:

```powershell
git add package.json scripts/lib/markdown-v2.mjs scripts/lib/markdown-v2.test.mjs scripts/senler-ui.mjs scripts/senler-tool.mjs
git commit -m "feat: expand mailing editor formatting"
```

Expected: commit succeeds. If Windows still denies `.git/index.lock`, report that implementation is complete but commit is blocked by repository ACL.
