import { describe, expect, it } from 'vitest';
import type { RecordDetailData, RecordDetailField } from '../../../../shared/protocol';
import { buildComparison } from './record-compare';

const field = (name: string, type = 'string', extra: Partial<RecordDetailField> = {}) =>
  ({
    name,
    label: name,
    type,
    referenceTo: [],
    picklistValues: [],
    inlineHelpText: null,
    required: false,
    custom: false,
    unique: false,
    externalId: false,
    filterable: true,
    sortable: true,
    groupable: true,
    ...extra,
  }) as RecordDetailField;

function rec(
  id: string,
  values: Record<string, unknown>,
  fields: RecordDetailField[] = [field('Name'), field('Phone'), field('Active', 'boolean')],
): RecordDetailData {
  return {
    objectName: 'Account',
    objectLabel: 'Account',
    id,
    fields,
    values,
    access: {},
    hiddenFields: [],
  };
}

const opts = { onlyDifferences: false, filter: '' };
const named = (...r: RecordDetailData[]) => r.map((record, i) => ({ name: `R${i}`, record }));

describe('buildComparison', () => {
  it('reports no difference for identical records', () => {
    const v = { Name: 'Acme', Phone: '1', Active: true };
    const c = buildComparison(named(rec('A', v), rec('B', v)), opts);
    expect(c.differing).toBe(0);
    expect(c.total).toBe(3);
  });

  it('flags the one field that differs, against the first column', () => {
    const c = buildComparison(
      named(
        rec('A', { Name: 'Acme', Phone: '1', Active: true }),
        rec('B', { Name: 'Acme', Phone: '2', Active: true }),
        rec('C', { Name: 'Acme', Phone: '1', Active: true }),
      ),
      opts,
    );
    const phone = c.rows.find((r) => r.name === 'Phone');
    expect(c.differing).toBe(1);
    expect(phone?.differsFromFirst).toEqual([false, true, false]);
  });

  it('treats null, undefined and absent as equal', () => {
    const c = buildComparison(
      named(rec('A', { Name: null }), rec('B', { Name: undefined }), rec('C', {})),
      opts,
    );
    expect(c.rows.find((r) => r.name === 'Name')?.differs).toBe(false);
  });

  it('treats an absent checkbox as false', () => {
    const c = buildComparison(named(rec('A', {}), rec('B', { Active: false })), opts);
    expect(c.rows.find((r) => r.name === 'Active')?.differs).toBe(false);
  });

  it('compares objects structurally, ignoring key order, and renders them the same way', () => {
    const f = [field('Addr', 'address')];
    const c = buildComparison(
      named(
        rec('A', { Addr: { city: 'X', zip: '1' } }, f),
        rec('B', { Addr: { zip: '1', city: 'X' } }, f),
      ),
      opts,
    );
    const row = c.rows[0];
    expect(row.differs).toBe(false);
    expect(row.values[0]).toBe(row.values[1]);
  });

  it('keeps 1 and "1" distinct', () => {
    const f = [field('N', 'string')];
    const c = buildComparison(named(rec('A', { N: 1 }, f), rec('B', { N: '1' }, f)), opts);
    expect(c.rows[0].differs).toBe(true);
  });

  it('takes the union of fields, ordered by API name', () => {
    const c = buildComparison(
      named(
        rec('A', {}, [field('Zed'), field('Alpha')]),
        rec('B', {}, [field('Mid'), field('Alpha')]),
      ),
      opts,
    );
    expect(c.rows.map((r) => r.name)).toEqual(['Alpha', 'Mid', 'Zed']);
  });

  it('keeps columns 1:1 with the input, in order', () => {
    const c = buildComparison(named(rec('A', {}), rec('B', {}), rec('C', {})), opts);
    expect(c.columns).toEqual([
      { name: 'R0', id: 'A' },
      { name: 'R1', id: 'B' },
      { name: 'R2', id: 'C' },
    ]);
  });

  it('shows only differences, counting before the text filter', () => {
    const c = buildComparison(
      named(
        rec('A', { Name: 'Acme', Phone: '1', Active: true }),
        rec('B', { Name: 'Globex', Phone: '2', Active: true }),
      ),
      { onlyDifferences: true, filter: 'phone' },
    );
    expect(c.rows.map((r) => r.name)).toEqual(['Phone']);
    expect(c.shown).toBe(2);
    expect(c.differing).toBe(2);
    expect(c.total).toBe(3);
  });

  it('filters on label, API name, type or any column value', () => {
    const a = rec('A', { Name: 'Acme', Phone: '111', Active: true });
    const b = rec('B', { Name: 'Globex', Phone: '222', Active: true });
    const by = (filter: string) =>
      buildComparison(named(a, b), { onlyDifferences: false, filter }).rows.map((r) => r.name);
    expect(by('globex')).toEqual(['Name']);
    expect(by('222')).toEqual(['Phone']);
    expect(by('boolean')).toEqual(['Active']);
  });
});
