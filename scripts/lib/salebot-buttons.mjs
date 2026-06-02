export function buildSaleBotButtons(campaign) {
  const cleanButtonItem = (item, index) => {
    const text = String(item?.text ?? item?.buttonText ?? "").trim();
    const url = String(item?.url ?? item?.buttonUrl ?? "").trim();
    if (!text || !url) return null;
    return {
      line: Number.isInteger(item?.line) ? item.line : index,
      index_in_line: Number.isInteger(item?.index_in_line) ? item.index_in_line : 0,
      text,
      type: item?.type || "inline",
      url,
      callback_link: Boolean(item?.callback_link),
    };
  };
  const items = Array.isArray(campaign?.buttons) && campaign.buttons.length
    ? campaign.buttons
    : [{ text: campaign?.buttonText, url: campaign?.buttonUrl, type: campaign?.buttonType }];
  return items.map(cleanButtonItem).filter(Boolean);
}
