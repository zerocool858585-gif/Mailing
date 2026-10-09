export function selectSenlerChannels(groupsConfig, { pick = "all", channelIds = [] } = {}) {
  const groups = groupsConfig?.groups || {};
  const keys = pick === "all" ? ["ege", "oge", "common"] : String(pick).split(",").map((value) => value.trim()).filter(Boolean);
  const requested = new Set((channelIds || []).map(String));
  const excluded = new Set(Object.values(groupsConfig?.excluded || {}).flat().map(String));
  const selected = [];
  const seen = new Set();

  for (const key of keys) {
    if (!Array.isArray(groups[key])) throw new Error(`Unknown group bucket: ${key}`);
    for (const rawId of groups[key]) {
      const id = String(rawId);
      if (seen.has(id) || excluded.has(id) || (requested.size && !requested.has(id))) continue;
      seen.add(id);
      selected.push({ id, bucket: key });
    }
  }
  return selected;
}
