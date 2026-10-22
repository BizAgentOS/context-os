// Keep browser drafts and navigation when an existing workspace is renamed.
// Legacy keys are read only for migration; all new writes use Context OS keys.
export function readBrowserValue(storage, key, legacyKeys = []) {
  const current = storage.getItem(key);
  if (current !== null) return current;
  for (const legacyKey of legacyKeys) {
    const value = storage.getItem(legacyKey);
    if (value === null) continue;
    try {
      storage.setItem(key, value);
      storage.removeItem(legacyKey);
    } catch { /* A full or blocked store must not hide the existing draft. */ }
    return value;
  }
  return null;
}
