// @ts-check
/**
 * Renders model <option> nodes into a picker, wrapping them in <optgroup>s when
 * more than one vendor is present. Shared by all four AI pickers so they agree
 * on grouping; each caller still owns its own sentinel rows (the "Auto" option,
 * the YAML form's disabled placeholder, the "no models" hint) and clears the
 * select itself, since those differ per picker.
 *
 * Grouping only shows up once a second vendor registers models — a BYOK provider
 * configured through Copilot's "Manage Models". With Copilot alone the markup is
 * a flat option list, exactly as before.
 */

import { excludeAutoModel, groupModelsByVendor, resolveSelectedModelId } from './model-picker';

/**
 * @param {HTMLSelectElement} select Target picker; existing children are kept.
 * @param {Array<{ id: string; name?: string; vendor?: string }>} models
 */
export function appendModelOptions(select, models) {
  for (const group of groupModelsByVendor(models ?? [])) {
    /** @type {HTMLSelectElement | HTMLOptGroupElement} */
    let parent = select;
    if (group.label) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      select.appendChild(optgroup);
      parent = optgroup;
    }
    for (const model of group.models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      parent.appendChild(option);
    }
  }
}

/**
 * Full rebuild of a model picker that leads with an "Auto" sentinel — Ask AI,
 * the Debug Logs analysis panel and the SOQL AI panel, which are identical here.
 * Owns every rule those three share, so none of them repeats it:
 *
 *  - the live selection is read before the options are cleared, so an
 *    unsolicited refresh cannot discard a pick the caller has not recorded yet;
 *  - Copilot's own "Auto" model is dropped, since the sentinel already means it
 *    (an empty modelId resolves to that very model at send time);
 *  - the "no models" row is driven by what the host actually sent, not by the
 *    filtered list, so an Auto-only list never reads as "none available".
 *
 * The YAML script form is deliberately NOT a caller: its empty value is a
 * disabled placeholder rather than Auto, so it keeps the real Auto model and
 * builds its own options.
 *
 * @param {HTMLSelectElement} select
 * @param {Array<{ id: string; name?: string; vendor?: string }>} models Models as received from the host.
 * @param {{ autoLabel: string, emptyLabel: string, candidates?: Array<string | null | undefined> }} opts
 *   `candidates` are fallback selections tried after the live DOM value, in order.
 * @returns {string} the value now selected ('' for Auto).
 */
export function renderModelPicker(select, models, opts) {
  const received = models ?? [];
  const list = excludeAutoModel(received);
  const current = select.value;

  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = opts.autoLabel;
  select.appendChild(auto);

  appendModelOptions(select, list);

  if (!received.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = opts.emptyLabel;
    select.appendChild(empty);
  }

  select.value = resolveSelectedModelId(list, [current, ...(opts.candidates ?? [])], '');
  return select.value;
}
