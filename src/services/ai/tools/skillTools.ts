// Agent-Skills tooling shared by the yaml-scripts AiExecutor and AskAiService
// (Overview tab). A "skill" is a reusable markdown playbook (SKILL.md) the
// model can pull in on demand via read_skill — the catalogue only ever lists
// id + description; the full body is fetched lazily, keeping the prompt cheap
// even when many skills are discovered.
import type { SkillInfo, SkillsRepository } from '../../skills/SkillsRepository';
import { stringArg, type ToolHandler } from './ToolHandler';

/** A markdown section listing the available skills, or '' when there are none. */
export function buildSkillsCatalogue(selected: SkillInfo[]): string {
  if (!selected.length) return '';
  const lines = selected.map((s) => `- ${s.id}: ${s.description || s.name}`);
  return (
    `\n\n## Available skills\n` +
    `Reusable playbooks you may consult. If one is relevant to the task, call ` +
    `read_skill with its id to read its full guidance before you answer.\n` +
    lines.join('\n')
  );
}

/** `read_skill` — fetches one skill's full body by id, from the injected repository. */
export function createReadSkillTool(skills: SkillsRepository): ToolHandler {
  return {
    spec: {
      name: 'read_skill',
      description:
        'Read the full content of one of the available skills (a markdown playbook with ' +
        'domain guidance) by its id. Call this when a listed skill is relevant to the task ' +
        'before writing your analysis. Returns the skill body as markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          skillId: {
            type: 'string',
            description: 'The id of the skill to read, taken from the "Available skills" list.',
          },
        },
        required: ['skillId'],
      },
    },
    run: (input, append) => {
      const id = stringArg(input, 'skillId');
      if (!id) return 'Error: no skill id provided.';
      append(`\n\n[read_skill] ${id}\n`);
      const body = skills.readSkill(id);
      if (body === null) {
        append(`→ error: unknown skill\n\n`);
        return `Error: unknown skill "${id}".`;
      }
      append(`→ ${body.length} char(s)\n\n`);
      return body;
    },
  };
}
