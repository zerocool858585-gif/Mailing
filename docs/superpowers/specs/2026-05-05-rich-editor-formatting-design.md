# Rich Editor Formatting Design

**Goal:** Expand the local mailing editor so Senler and SaleBot / Telegram expose the formatting features each platform supports, while preserving the current campaign files and automation flow.

**Sources Checked**

- Senler VK formatting: bold, italic, underline, links.
- Senler Telegram formatting: bold, italic, underline, strikethrough, monospace, spoiler, quote, links.
- Telegram Bot API formatting: MarkdownV2 supports bold, italic, underline, strikethrough, spoiler, blockquote, inline links, inline code, and preformatted code; special characters must be escaped.
- Senler variables: standard variables such as `%username%`, `%fullname%`, `%userid%`, `%domain%`; custom variables such as `{%email%}`; global variables such as `[%var%]`; dynamic helpers such as `[rand]...[/rand]` and `[date]...[/date]`.

**Current System**

- The UI is served from `scripts/senler-ui.mjs` as one embedded HTML page.
- Senler campaigns are saved as plain `message` text plus a `formats` array with Quill-style ranges.
- Senler automation in `scripts/senler-tool.mjs` opens Senler and applies supported Quill formatting to the remote editor.
- SaleBot / Telegram campaigns save `message` as Markdown text and send it to SaleBot with markdown enabled.
- The current local editor supports only bold, italic, and underline.

**Chosen Approach**

Use one shared editing model in the browser, but expose platform-specific toolbar controls:

- Senler tab: bold, italic, underline, link, and Senler variable insertion.
- SaleBot / Telegram tab: bold, italic, underline, strikethrough, inline code, code block, spoiler, quote, link.

This avoids showing controls that the current Senler VK flow cannot reliably apply, while giving Telegram the full MarkdownV2 feature set requested by the user.

**Senler Behavior**

- Keep saving the raw visible text in `message`.
- Extend the local format collector to detect links in addition to bold, italic, and underline.
- Store link ranges in `formats` with `link: "https://..."`.
- Update `scripts/senler-tool.mjs` so Quill receives `{ link: url }` for those ranges.
- Insert Senler variables as plain text at the caret. Variable text must not be escaped or transformed.
- Provide quick variable choices:
  - `%username%`
  - `%fullname%`
  - `%userid%`
  - `%domain%`
  - `{%email%}`
  - `[%var%]`
  - `[rand]текст 1|текст 2|текст 3[/rand]`
  - `[date]%e %month|+1 day[/date]`
- Provide a custom variable action where the user can type a variable name and choose user variable `{%name%}` or global variable `[%name%]`.

**SaleBot / Telegram Behavior**

- Keep MarkdownV2 as the saved output format.
- Convert the contenteditable DOM to MarkdownV2 on save.
- Support these DOM tags and output forms:
  - `<strong>` -> `*text*`
  - `<em>` -> `_text_`
  - `<u>` -> `__text__`
  - `<s>` -> `~text~`
  - `<code>` -> `` `text` ``
  - `<pre>` -> fenced code block
  - spoiler span -> `||text||`
  - blockquote -> each line prefixed with `>`
  - `<a href>` -> `[text](url)`
- Escape MarkdownV2 special characters in plain text and inside links according to Telegram rules.
- Preserve existing campaign compatibility by expanding `tgMarkdownToHtml()` for common MarkdownV2 constructs when opening saved drafts.

**Toolbar UX**

- Add compact icon-like buttons with text labels that already match the existing UI style.
- Keep the current contenteditable editors.
- Link button flow:
  1. Use the selected text as link text.
  2. Prompt for URL.
  3. Apply or update `<a href="...">`.
  4. If no text is selected, insert the URL as linked text.
- Variable flow on Senler:
  1. A select menu lists common variables.
  2. Choosing an item inserts it at the caret.
  3. A custom action prompts for a variable name and inserts the selected wrapper.

**Data Compatibility**

- Existing Senler campaigns without links still load and save.
- Existing SaleBot Markdown messages still load; unsupported legacy edge cases may load as plain text instead of formatted text, but saving must produce valid MarkdownV2.
- No schema migration is required. New fields in `formats` are optional.

**Validation**

- Add focused automated checks for MarkdownV2 escaping and DOM-to-Markdown conversion if the project test setup can support it without large scaffolding.
- At minimum, verify manually with local UI load, save, and inspect campaign JSON.
- Verify Senler automation still accepts existing bold / italic / underline ranges.
- Verify SaleBot output for a mixed message with bold, underline, strike, spoiler, code, quote, and link.

**Out of Scope**

- Splitting Senler into separate VK and Telegram tabs.
- Switching SaleBot / Telegram to HTML parse mode.
- Adding a full WYSIWYG Markdown parser.
- Managing Senler variable definitions outside the message editor.
