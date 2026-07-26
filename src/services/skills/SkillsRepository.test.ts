import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillsRepository } from './SkillsRepository';

function writeSkill(
  root: string,
  dir: string,
  id: string,
  frontmatter: string,
  body: string,
): void {
  const skillDir = path.join(root, dir, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

describe('SkillsRepository', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists skills with name + description from frontmatter, sorted by id', () => {
    writeSkill(tmp, '.claude/skills', 'zeta', 'name: Zeta\ndescription: last one', '# Z');
    writeSkill(tmp, '.claude/skills', 'alpha', 'name: Alpha\ndescription: first one', '# A');
    const repo = new SkillsRepository(tmp, ['.claude/skills']);
    expect(repo.listSkills()).toEqual([
      { id: 'alpha', name: 'Alpha', description: 'first one' },
      { id: 'zeta', name: 'Zeta', description: 'last one' },
    ]);
  });

  it('falls back to the folder name when frontmatter has no name', () => {
    writeSkill(tmp, '.claude/skills', 'noname', 'description: just a desc', 'body');
    const repo = new SkillsRepository(tmp, ['.claude/skills']);
    expect(repo.listSkills()[0]).toEqual({
      id: 'noname',
      name: 'noname',
      description: 'just a desc',
    });
  });

  it('skips folders without a SKILL.md and missing dirs', () => {
    fs.mkdirSync(path.join(tmp, '.claude/skills/empty'), { recursive: true });
    writeSkill(tmp, '.claude/skills', 'real', 'name: Real\ndescription: d', 'body');
    const repo = new SkillsRepository(tmp, ['.claude/skills', '.github/skills']);
    expect(repo.listSkills().map((s) => s.id)).toEqual(['real']);
  });

  it('dedupes across dirs, first dir wins', () => {
    writeSkill(tmp, '.claude/skills', 'dup', 'name: From Claude\ndescription: c', 'claude');
    writeSkill(tmp, '.github/skills', 'dup', 'name: From GitHub\ndescription: g', 'github');
    const repo = new SkillsRepository(tmp, ['.claude/skills', '.github/skills']);
    const dup = repo.listSkills().find((s) => s.id === 'dup');
    expect(dup?.name).toBe('From Claude');
  });

  it('reads a known skill body with frontmatter stripped', () => {
    writeSkill(
      tmp,
      '.claude/skills',
      'dq',
      'name: DQ\ndescription: d',
      '# Heading\n\nDo the thing.',
    );
    const repo = new SkillsRepository(tmp, ['.claude/skills']);
    const body = repo.readSkill('dq');
    expect(body).toBe('# Heading\n\nDo the thing.');
    expect(body).not.toContain('description');
  });

  it('returns null for an unknown skill id', () => {
    writeSkill(tmp, '.claude/skills', 'dq', 'name: DQ\ndescription: d', 'body');
    const repo = new SkillsRepository(tmp, ['.claude/skills']);
    expect(repo.readSkill('does-not-exist')).toBeNull();
  });

  it('rejects traversal-style ids (only discovered ids are readable)', () => {
    writeSkill(tmp, '.claude/skills', 'dq', 'name: DQ\ndescription: d', 'body');
    const repo = new SkillsRepository(tmp, ['.claude/skills']);
    expect(repo.readSkill('../../etc/passwd')).toBeNull();
    expect(repo.readSkill('../dq')).toBeNull();
  });
});
