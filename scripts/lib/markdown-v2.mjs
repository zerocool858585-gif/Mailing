const MARKDOWN_V2_SPECIALS = /([_*[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(value) {
  return String(value ?? "").replace(MARKDOWN_V2_SPECIALS, "\\$1");
}

export function escapeMarkdownV2Code(value) {
  return String(value ?? "").replace(/[\\`]/g, "\\$&");
}

export function escapeMarkdownV2Url(value) {
  return String(value ?? "").replace(/[\\)]/g, "\\$&");
}
