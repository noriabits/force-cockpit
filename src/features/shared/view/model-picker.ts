// Model <select> logic shared by the four AI pickers (Ask AI, Debug Logs
// analysis, the SOQL AI panel and the YAML script form). Pure and DOM-free —
// each caller still builds its own <option>/<optgroup> nodes; this module only
// decides what goes in them and which value survives a rebuild.
//
// Rebuilds are no longer only user-driven: ChatModelWatcher pushes a refreshed
// list whenever VS Code's model set changes, which can land while a picker is
// open and a form is half-filled. Hence resolveSelectedModelId(), which takes
// the live DOM value as its first candidate so a background refresh cannot
// silently move the user's choice.

import { isAutoModel } from '../../../services/ai/modelSelection';

/** Minimal model shape — satisfied by the ChatModelInfo entries the host sends. */
export interface ModelOption {
  id: string;
  name?: string;
  vendor?: string;
}

export interface ModelGroup {
  vendor: string;
  /** Human label for the <optgroup>; empty when the list has a single vendor. */
  label: string;
  models: ModelOption[];
}

/**
 * Display names for the vendors Copilot Chat contributes. VS Code does not put a
 * provider's displayName on the model object, so this mirrors the names from its
 * `languageModelChatProviders` contribution; anything unknown shows its raw id.
 */
const VENDOR_LABELS: Record<string, string> = {
  copilot: 'Copilot',
  copilotcli: 'Copilot CLI',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google',
  xai: 'xAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  azure: 'Azure',
  customendpoint: 'Custom Endpoint',
  customoai: 'OpenAI Compatible',
};

export function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor;
}

/** The Auto model's id, or '' when the list has none. */
export function autoModelId(models: readonly ModelOption[]): string {
  return models.find((m) => isAutoModel({ id: m.id, name: m.name }))?.id ?? '';
}

/**
 * Drops Copilot's own "Auto" model from the list.
 *
 * For the three pickers that prepend an "Auto" sentinel (value ''), rendering
 * the real model too would show "Auto" twice for one behaviour: an empty
 * modelId makes the gateway pick `models.find(isAutoModel)` — that very model.
 * The YAML script form has no sentinel (its '' is a disabled placeholder), so it
 * keeps the real entry and must NOT use this.
 */
export function excludeAutoModel(models: readonly ModelOption[]): ModelOption[] {
  return models.filter((m) => !isAutoModel({ id: m.id, name: m.name }));
}

/**
 * Models grouped by vendor, Copilot first and the rest alphabetical by label.
 *
 * A single vendor yields ONE group with an empty label — callers render that
 * flat, so the ordinary Copilot-only picker looks exactly as it always has.
 * Groups only become visible once a second vendor is in play (a BYOK provider
 * configured through Copilot's "Manage Models"), where they answer the question
 * the bare model name cannot: which subscription does this model bill against.
 */
export function groupModelsByVendor(models: readonly ModelOption[]): ModelGroup[] {
  const byVendor = new Map<string, ModelOption[]>();
  for (const model of models) {
    const vendor = model.vendor ?? '';
    const bucket = byVendor.get(vendor);
    if (bucket) bucket.push(model);
    else byVendor.set(vendor, [model]);
  }

  if (byVendor.size <= 1) {
    const vendor = [...byVendor.keys()][0] ?? '';
    return models.length ? [{ vendor, label: '', models: [...models] }] : [];
  }

  return [...byVendor.entries()]
    .map(([vendor, vendorModels]) => ({
      vendor,
      label: vendorLabel(vendor),
      models: vendorModels,
    }))
    .sort((a, b) => {
      // Copilot stays on top (it is what most users are actually on); the rest
      // sort by their display label so the order is stable across refreshes.
      if (a.vendor === 'copilot') return -1;
      if (b.vendor === 'copilot') return 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * The value a model <select> should carry once its options have been rebuilt.
 * The first candidate that is both non-empty and still present in `models` wins;
 * otherwise `fallback`.
 *
 * Callers pass the live DOM value first, then their remembered pick — that order
 * is what keeps an unsolicited refresh from discarding a selection the host has
 * not been told about yet. `fallback` differs per picker: '' means "Auto" in
 * three of them, but the YAML script form uses '' for its disabled placeholder
 * and passes autoModelId() instead.
 */
export function resolveSelectedModelId(
  models: readonly ModelOption[],
  candidates: readonly (string | null | undefined)[],
  fallback = '',
): string {
  for (const candidate of candidates) {
    if (candidate && models.some((m) => m.id === candidate)) return candidate;
  }
  return fallback;
}
