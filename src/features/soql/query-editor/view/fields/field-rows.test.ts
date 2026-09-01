import { describe, expect, it } from 'vitest';
import {
  buildRowModel,
  fieldKeys,
  MAX_EXPAND_DEPTH,
  type DescribeField,
  type DescribeObject,
  type RowModelInput,
} from './field-rows';

const field = (name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField => ({
  name,
  label: `${name} label`,
  type,
  relationshipName: null,
  referenceTo: [],
  picklistValues: [],
  ...extra,
});

const ACCOUNT: DescribeObject = {
  fields: [
    field('Id', 'id'),
    field('Name', 'string'),
    field('Industry', 'picklist', { picklistValues: ['Banking'] }),
    field('OwnerId', 'reference', { relationshipName: 'Owner', referenceTo: ['User'] }),
  ],
};
const USER: DescribeObject = {
  fields: [
    field('Email', 'email'),
    field('ManagerId', 'reference', { relationshipName: 'Manager', referenceTo: ['User'] }),
  ],
};

const CATALOGUE: Record<string, DescribeObject> = { user: USER, account: ACCOUNT };

function input(over: Partial<RowModelInput> = {}): RowModelInput {
  return {
    object: ACCOUNT,
    describeOf: (name) => CATALOGUE[name.toLowerCase()],
    expandedRefs: new Set(),
    expandedPicklists: new Set(),
    selected: new Set(),
    showCheckbox: true,
    search: '',
    ...over,
  };
}

const nameAt = (rows: ReturnType<typeof buildRowModel>['rows']) =>
  rows.map((r) => (r.kind === 'field' ? r.field.name : `values(${r.field.name})`));

describe('fieldKeys', () => {
  it('addresses a top-level field by its own name', () => {
    expect(fieldKeys(field('Name', 'string'), '')).toEqual({
      checkboxPath: 'Name',
      refKey: null,
      picklistKey: null,
    });
  });

  it('builds the ref key from the relationship name, the checkbox path from the field name', () => {
    const f = field('OwnerId', 'reference', { relationshipName: 'Owner', referenceTo: ['User'] });
    expect(fieldKeys(f, 'Account')).toMatchObject({
      checkboxPath: 'Account.OwnerId',
      refKey: 'account.owner',
    });
  });

  it('keys a picklist by its dotted path, lowercased', () => {
    const f = field('Industry', 'picklist');
    expect(fieldKeys(f, 'Owner').picklistKey).toBe('owner.industry');
  });
});

describe('buildRowModel', () => {
  it('lists the object’s own fields at depth 0 and needs nothing', () => {
    const { rows, pending } = buildRowModel(input());
    expect(nameAt(rows)).toEqual(['Id', 'Name', 'Industry', 'OwnerId']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    expect(pending).toEqual([]);
  });

  it('ticks a field the SELECT clause already names, case-insensitively', () => {
    const { rows } = buildRowModel(input({ selected: new Set(['name']) }));
    const byName = Object.fromEntries(
      rows.map((r) => [r.kind === 'field' ? r.field.name : '', r.kind === 'field' && r.checked]),
    );
    expect(byName.Name).toBe(true);
    expect(byName.Id).toBe(false);
  });

  it('never reports a field as checked while checkboxes are hidden', () => {
    const { rows } = buildRowModel(input({ selected: new Set(['name']), showCheckbox: false }));
    expect(rows.every((r) => r.kind === 'field' && !r.checked)).toBe(true);
  });

  describe('expansion', () => {
    it('offers a chevron for a reference and for a picklist, but not a plain field', () => {
      const { rows } = buildRowModel(input());
      const expansion = (name: string) => {
        const row = rows.find((r) => r.kind === 'field' && r.field.name === name);
        return row && row.kind === 'field' ? row.expansion : undefined;
      };
      expect(expansion('Name')).toBeNull();
      expect(expansion('OwnerId')).toEqual({ set: 'ref', key: 'owner', expanded: false });
      expect(expansion('Industry')).toEqual({ set: 'picklist', key: 'industry', expanded: false });
    });

    it('nests the target’s fields under the dotted relationship path', () => {
      const { rows, pending } = buildRowModel(input({ expandedRefs: new Set(['owner']) }));
      expect(nameAt(rows)).toEqual(['Id', 'Name', 'Industry', 'OwnerId', 'Email', 'ManagerId']);
      expect(pending).toEqual([]);

      const email = rows.find((r) => r.kind === 'field' && r.field.name === 'Email');
      expect(email).toMatchObject({ depth: 1, checkboxPath: 'Owner.Email' });
    });

    it('checks a nested field against its dotted path, not its own name', () => {
      const { rows } = buildRowModel(
        input({ expandedRefs: new Set(['owner']), selected: new Set(['owner.email']) }),
      );
      const email = rows.find((r) => r.kind === 'field' && r.field.name === 'Email');
      expect(email && email.kind === 'field' && email.checked).toBe(true);
    });

    it('emits a values row for an expanded picklist', () => {
      const { rows } = buildRowModel(input({ expandedPicklists: new Set(['industry']) }));
      expect(nameAt(rows)).toEqual(['Id', 'Name', 'Industry', 'values(Industry)', 'OwnerId']);
    });

    it('stops offering a relationship chevron at the traversal limit', () => {
      // A chain of Manager lookups, expanded all the way down.
      const expanded = new Set<string>(['owner']);
      let key = 'owner';
      for (let i = 0; i < MAX_EXPAND_DEPTH + 2; i++) {
        key = `${key}.manager`;
        expanded.add(key);
      }
      const { rows } = buildRowModel(input({ expandedRefs: expanded }));

      const managers = rows.filter((r) => r.kind === 'field' && r.field.name === 'ManagerId');
      const deepest = managers[managers.length - 1];
      expect(deepest.depth).toBe(MAX_EXPAND_DEPTH);
      expect(deepest.kind === 'field' && deepest.expansion).toBeNull();
    });

    it('keeps the picklist chevron at the deepest level', () => {
      const { rows } = buildRowModel(
        input({ object: { fields: [field('Stage', 'picklist', { picklistValues: ['A'] })] } }),
      );
      expect(rows[0].kind === 'field' && rows[0].expansion).toMatchObject({ set: 'picklist' });
    });
  });

  describe('pending describes', () => {
    it('names an expanded target that has not resolved yet, and renders without it', () => {
      const { rows, pending } = buildRowModel(
        input({ expandedRefs: new Set(['owner']), describeOf: () => undefined }),
      );
      expect(pending).toEqual(['User']);
      expect(nameAt(rows)).toEqual(['Id', 'Name', 'Industry', 'OwnerId']);
    });

    it('does NOT re-request an object already answered with nothing', () => {
      // null means "described, came back empty or failed". Treating it as
      // missing would fetch that object forever.
      const { pending } = buildRowModel(
        input({ expandedRefs: new Set(['owner']), describeOf: () => null }),
      );
      expect(pending).toEqual([]);
    });

    it('asks one level at a time', () => {
      const { pending } = buildRowModel(
        input({
          expandedRefs: new Set(['owner', 'owner.manager']),
          describeOf: (name) => (name === 'User' ? undefined : CATALOGUE[name.toLowerCase()]),
        }),
      );
      expect(pending).toEqual(['User']);
    });
  });

  describe('search', () => {
    it('collapses to a flat ranked list of the object’s own fields', () => {
      const { rows, pending } = buildRowModel(
        input({ search: 'nam', expandedRefs: new Set(['owner']) }),
      );
      expect(nameAt(rows)).toEqual(['Name']);
      expect(rows[0].depth).toBe(0);
      expect(pending).toEqual([]);
    });

    it('offers no expansion, since this branch emits no nested or values rows', () => {
      const { rows } = buildRowModel(
        input({ search: 'industry', expandedPicklists: new Set(['industry']) }),
      );
      expect(nameAt(rows)).toEqual(['Industry']);
      expect(rows[0].kind === 'field' && rows[0].expansion).toBeNull();
    });

    it('still reflects the SELECT clause', () => {
      const { rows } = buildRowModel(input({ search: 'nam', selected: new Set(['name']) }));
      expect(rows[0].kind === 'field' && rows[0].checked).toBe(true);
    });
  });
});
