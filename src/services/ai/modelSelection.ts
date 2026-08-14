// Model list resolution shared by the gateway and the webview pickers.
//
// Pure on purpose: NO `vscode` import, no node imports, no DOM types. The
// browser bundles pull this in through features/shared/view/model-picker.ts, so
// anything platform-specific here would break `npm run build`.
//
// Two vendors can register the same model id — Copilot registers `copilot` and
// (hidden) `copilotcli`, which both offer `claude-sonnet-5`, `auto`, and the
// rest. De-duplicating by id keeps the picker honest, but only if the gateway's
// listing and its send-time lookup agree on WHICH duplicate survives. That is
// what this module guarantees: both call sites resolve the same array.

/** Everything the resolution rules need off a model — satisfied by ChatModelInfo and by vscode.LanguageModelChat. */
export interface ModelIdentity {
  id: string;
  vendor: string;
}

/**
 * Vendors that win an id collision, most-preferred first; unlisted vendors rank
 * after these and keep their relative order. `copilot` is listed because it is
 * the vendor the user actually manages — `copilotcli` is contributed with
 * `when: false`, i.e. hidden from VS Code's own model picker, yet still
 * resolvable through the API.
 */
export const VENDOR_PRIORITY: readonly string[] = ['copilot'];

function vendorRank(vendor: string): number {
  const index = VENDOR_PRIORITY.indexOf(vendor);
  return index === -1 ? VENDOR_PRIORITY.length : index;
}

/**
 * Copilot's "Auto" model — the one we fall back to when a requested model is
 * gone. Detected leniently by name or id (case-insensitive) because it is not
 * flagged in any way by the API.
 */
export function isAutoModel(model: { id: string; name?: string }): boolean {
  return model.id.toLowerCase() === 'auto' || (model.name ?? '').trim().toLowerCase() === 'auto';
}

/**
 * One entry per model id. The winner is the highest-ranked vendor; ties keep the
 * earliest entry, so the result is stable and independent of the order VS Code
 * happens to return providers in.
 *
 * Note this de-duplicates by id ONLY. A vendor with its own id scheme (a BYOK
 * provider, say) is left alone — those are genuinely distinct endpoints with
 * their own auth, quota and billing, and hiding one would make it unreachable.
 * Telling them apart in the UI is the picker's job (see model-picker.ts).
 */
export function dedupeModels<T extends ModelIdentity>(models: readonly T[]): T[] {
  const winners = new Map<string, T>();
  for (const model of models) {
    const current = winners.get(model.id);
    if (!current || vendorRank(model.vendor) < vendorRank(current.vendor)) {
      winners.set(model.id, model);
    }
  }
  return [...winners.values()];
}

/**
 * The model a request should run on. `models` must already be de-duplicated —
 * pass the same array the picker was built from, so a saved id always resolves
 * to the entry the user actually chose.
 *
 * When the requested model is gone (or none was requested) this prefers "Auto"
 * over an arbitrary first entry. `fellBack` reports only the case worth warning
 * about: the user asked for something specific and did not get it.
 */
export function pickModel<T extends ModelIdentity & { name: string }>(
  models: readonly T[],
  requestedId?: string,
): { model: T | undefined; fellBack: boolean } {
  const found = requestedId ? models.find((m) => m.id === requestedId) : undefined;
  const model = found ?? models.find(isAutoModel) ?? models[0];
  return { model, fellBack: Boolean(requestedId) && !found };
}
