import { describe, it, expect } from 'vitest';
import { applyListFilter, FilterableElement, ListFilterAttrs } from './list-filter';

interface FakeEl extends FilterableElement {
  attrs: ListFilterAttrs;
  style: { display: string };
}

function makeEl(attrs: ListFilterAttrs): FakeEl {
  return {
    attrs,
    style: { display: 'INITIAL' },
    getAttribute: () => null,
  };
}

const getAttrs = (el: FakeEl) => el.attrs;
const matchAll = () => true;

describe('applyListFilter', () => {
  it('shows all when query is empty and matches passes', () => {
    const els = [
      makeEl({ folder: 'orders', source: 'user', searchText: 'Alpha' }),
      makeEl({ folder: 'users', source: 'private', searchText: 'Beta' }),
    ];
    const count = applyListFilter({ elements: els, getAttrs, matches: matchAll, query: '' });
    expect(count).toBe(2);
    expect(els.map((e) => e.style.display)).toEqual(['', '']);
  });

  it('hides elements the predicate rejects', () => {
    const els = [
      makeEl({ folder: 'orders', source: 'user', searchText: 'Alpha' }),
      makeEl({ folder: 'users', source: 'private', searchText: 'Beta' }),
    ];
    const count = applyListFilter({
      elements: els,
      getAttrs,
      matches: (item) => item.folder === 'orders',
      query: '',
    });
    expect(count).toBe(1);
    expect(els[0].style.display).toBe('');
    expect(els[1].style.display).toBe('none');
  });

  it('applies a case-insensitive substring text match', () => {
    const els = [
      makeEl({ folder: 'a', source: 'user', searchText: 'Run the Pipeline' }),
      makeEl({ folder: 'b', source: 'user', searchText: 'Other thing' }),
    ];
    const count = applyListFilter({
      elements: els,
      getAttrs,
      matches: matchAll,
      query: 'PIPE',
    });
    expect(count).toBe(1);
    expect(els[0].style.display).toBe('');
    expect(els[1].style.display).toBe('none');
  });

  it('combines predicate AND text match', () => {
    const els = [
      makeEl({ folder: 'orders', source: 'user', searchText: 'keep me' }),
      makeEl({ folder: 'orders', source: 'user', searchText: 'drop me' }),
      makeEl({ folder: 'users', source: 'user', searchText: 'keep me' }),
    ];
    const count = applyListFilter({
      elements: els,
      getAttrs,
      matches: (item) => item.folder === 'orders',
      query: 'keep',
    });
    expect(count).toBe(1);
    expect(els.map((e) => e.style.display)).toEqual(['', 'none', 'none']);
  });

  it('passes id through to the predicate (favorites filter)', () => {
    const seen: Array<string | undefined> = [];
    const els = [
      makeEl({ folder: 'a', source: 'user', id: 'one', searchText: '' }),
      makeEl({ folder: 'b', source: 'user', id: 'two', searchText: '' }),
    ];
    applyListFilter({
      elements: els,
      getAttrs,
      matches: (item) => {
        seen.push(item.id);
        return item.id === 'one';
      },
      query: '',
    });
    expect(seen).toEqual(['one', 'two']);
    expect(els[0].style.display).toBe('');
    expect(els[1].style.display).toBe('none');
  });

  it('uses the custom display value for visible elements', () => {
    const els = [makeEl({ folder: 'a', source: 'user', searchText: 'x' })];
    applyListFilter({ elements: els, getAttrs, matches: matchAll, query: '', display: 'block' });
    expect(els[0].style.display).toBe('block');
  });

  it('trims whitespace-only queries to mean "no filter"', () => {
    const els = [makeEl({ folder: 'a', source: 'user', searchText: 'anything' })];
    const count = applyListFilter({ elements: els, getAttrs, matches: matchAll, query: '   ' });
    expect(count).toBe(1);
    expect(els[0].style.display).toBe('');
  });

  it('accepts an ArrayLike (NodeList-style) collection', () => {
    const arr = [
      makeEl({ folder: 'a', source: 'user', searchText: 'one' }),
      makeEl({ folder: 'b', source: 'user', searchText: 'two' }),
    ];
    const arrayLike: ArrayLike<FakeEl> = { length: arr.length, 0: arr[0], 1: arr[1] };
    const count = applyListFilter({
      elements: arrayLike,
      getAttrs,
      matches: matchAll,
      query: 'two',
    });
    expect(count).toBe(1);
  });
});
