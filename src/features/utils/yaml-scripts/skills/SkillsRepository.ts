import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/** Lightweight catalogue entry for an Agent Skill discovered on disk. */
export interface SkillInfo {
  /** Stable id used in YAML / the `read_skill` tool — the skill folder name. */
  id: string;
  /** Display name (from frontmatter `name`, falling back to the id). */
  name: string;
  /** One-line summary (from frontmatter `description`). */
  description: string;
}

type SkillFrontmatter = {
  name?: unknown;
  description?: unknown;
};

/**
 * Discovers and reads Agent Skills from the workspace. A skill is a sub-folder
 * containing a `SKILL.md` file with YAML frontmatter (`name` + `description`)
 * followed by a markdown body — the standard Agent Skills layout.
 *
 * vscode-free (pure `fs`/`path`/`js-yaml`) so it can be unit-tested and injected
 * into the vscode-free `AiExecutor`.
 */
export class SkillsRepository {
  /**
   * @param workspaceRoot absolute path of the open workspace folder.
   * @param skillDirs workspace-relative dirs to scan, in priority order
   *        (first match wins on id collisions), e.g.
   *        `['.claude/skills', '.github/skills']`.
   */
  constructor(
    private readonly workspaceRoot: string,
    private readonly skillDirs: string[],
  ) {}

  /** Discover every skill across the configured dirs, deduped by id. */
  listSkills(): SkillInfo[] {
    const byId = new Map<string, SkillInfo>();
    for (const skillDir of this.skillDirs) {
      for (const info of this.scanDir(skillDir)) {
        if (!byId.has(info.id)) byId.set(info.id, info);
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Return the body of a skill's `SKILL.md` (frontmatter stripped), or `null`
   * when the id is unknown. Traversal-safe: the id is matched against the
   * discovered set, never joined into a path verbatim.
   */
  readSkill(id: string): string | null {
    const filePath = this.resolveSkillFile(id);
    if (!filePath) return null;
    try {
      return stripFrontmatter(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Locate a known skill's SKILL.md path, or null when the id isn't discovered. */
  private resolveSkillFile(id: string): string | null {
    if (!this.listSkills().some((s) => s.id === id)) return null;
    if (!this.workspaceRoot) return null;
    for (const skillDir of this.skillDirs) {
      const candidate = path.join(this.workspaceRoot, skillDir, id, 'SKILL.md');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private scanDir(skillDir: string): SkillInfo[] {
    if (!this.workspaceRoot) return [];
    const root = path.join(this.workspaceRoot, skillDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // missing dir → skip silently
    }
    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      let raw: string;
      try {
        raw = fs.readFileSync(skillFile, 'utf8');
      } catch {
        continue; // no SKILL.md → not a skill folder
      }
      const fm = parseFrontmatter(raw);
      skills.push({
        id: entry.name,
        name: typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : entry.name,
        description: typeof fm.description === 'string' ? fm.description.trim() : '',
      });
    }
    return skills;
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return {};
  try {
    const parsed = yaml.load(match[1]);
    return parsed && typeof parsed === 'object' ? (parsed as SkillFrontmatter) : {};
  } catch {
    return {};
  }
}

function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, '').trim();
}
