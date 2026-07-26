import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DescribeDiskCache } from './DescribeDiskCache';
import type { DescribeSObjectProjection } from './DescribeService';

const SAMPLE: DescribeSObjectProjection = {
  name: 'Account',
  fields: [
    {
      name: 'Id',
      label: 'Id',
      type: 'id',
      relationshipName: null,
      referenceTo: [],
      picklistValues: [],
    },
  ],
};

describe('DescribeDiskCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-cache-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an sObject describe', () => {
    const cache = new DescribeDiskCache(dir);
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    expect(cache.readSObject('ORG1', 'Account')).toEqual(SAMPLE);
  });

  it('round-trips a global describe', () => {
    const cache = new DescribeDiskCache(dir);
    const global = { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] };
    cache.writeGlobal('ORG1', global);
    expect(cache.readGlobal('ORG1')).toEqual(global);
  });

  it('returns null on a miss', () => {
    const cache = new DescribeDiskCache(dir);
    expect(cache.readSObject('ORG1', 'Account')).toBeNull();
    expect(cache.readGlobal('ORG1')).toBeNull();
  });

  it('keys by org so different orgs do not collide', () => {
    const cache = new DescribeDiskCache(dir);
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    expect(cache.readSObject('ORG2', 'Account')).toBeNull();
  });

  it('treats entries older than the TTL as a miss', () => {
    const cache = new DescribeDiskCache(dir, 1000); // 1s TTL
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    // Rewrite the file with a stale timestamp.
    const file = path.join(dir, 'org1', 'sobject_account.json');
    fs.writeFileSync(file, JSON.stringify({ cachedAt: Date.now() - 5000, data: SAMPLE }), 'utf8');
    expect(cache.readSObject('ORG1', 'Account')).toBeNull();
  });

  it('writes a self-ignoring .gitignore on first write', () => {
    const cache = new DescribeDiskCache(dir);
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('returns null (no throw) on corrupt JSON', () => {
    const cache = new DescribeDiskCache(dir);
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    fs.writeFileSync(path.join(dir, 'org1', 'sobject_account.json'), 'not json {', 'utf8');
    expect(cache.readSObject('ORG1', 'Account')).toBeNull();
  });

  it('clear(orgId) removes only that org', () => {
    const cache = new DescribeDiskCache(dir);
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    cache.writeSObject('ORG2', 'Account', SAMPLE);
    cache.clear('ORG1');
    expect(cache.readSObject('ORG1', 'Account')).toBeNull();
    expect(cache.readSObject('ORG2', 'Account')).toEqual(SAMPLE);
  });

  it('clear() removes the whole cache', () => {
    const cache = new DescribeDiskCache(dir);
    cache.writeSObject('ORG1', 'Account', SAMPLE);
    cache.writeSObject('ORG2', 'Account', SAMPLE);
    cache.clear();
    expect(cache.readSObject('ORG1', 'Account')).toBeNull();
    expect(cache.readSObject('ORG2', 'Account')).toBeNull();
  });
});
