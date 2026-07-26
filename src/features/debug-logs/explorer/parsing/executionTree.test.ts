import { describe, expect, it } from 'vitest';
import { buildExecutionTree, flattenTimings, pruneDepth } from './executionTree';
import { parseLog } from './logLine';
import { SUCCESS_LOG } from './__fixtures__/logs';

describe('buildExecutionTree', () => {
  it('nests methods under their code unit with total and self times', () => {
    const tree = buildExecutionTree(parseLog(SUCCESS_LOG).events);
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root.name).toBe('AccountService.run');
    expect(root.kind).toBe('codeUnit');
    expect(root.totalMs).toBe(20);
    expect(root.children).toHaveLength(1);
    const method = root.children[0];
    expect(method.name).toBe('AccountService.loadAccounts()');
    expect(method.totalMs).toBe(5);
    // Self time excludes the child's 5 ms.
    expect(root.selfMs).toBe(15);
  });

  it('tolerates an unclosed node (truncated log) with a null duration', () => {
    const log = ['09:00:00.1 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|01p|Orphan'].join('\n');
    const tree = buildExecutionTree(parseLog(log).events);
    expect(tree[0].name).toBe('Orphan');
    expect(tree[0].totalMs).toBeNull();
  });

  it('prefers the readable label over an internal __sfdc_ typeRef', () => {
    const log =
      '09:00:00.1 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01q|OrderTrigger on Order|__sfdc_trigger/OrderTrigger';
    expect(buildExecutionTree(parseLog(log).events)[0].name).toBe('OrderTrigger on Order');
  });
});

describe('flattenTimings', () => {
  it('walks the tree depth-first', () => {
    const tree = buildExecutionTree(parseLog(SUCCESS_LOG).events);
    expect(flattenTimings(tree).map((n) => n.kind)).toEqual(['codeUnit', 'method']);
  });
});

describe('pruneDepth', () => {
  it('drops levels beyond the requested depth', () => {
    const tree = buildExecutionTree(parseLog(SUCCESS_LOG).events);
    expect(pruneDepth(tree, 1)[0].children).toEqual([]);
    expect(pruneDepth(tree, 2)[0].children).toHaveLength(1);
    expect(pruneDepth(tree, 0)).toEqual([]);
  });
});
