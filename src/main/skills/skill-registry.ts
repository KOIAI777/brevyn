export interface SkillBlueprint {
  id: string;
  name: string;
  description: string;
  version: string;
  defaultEnabled: boolean;
  instructions: string;
}

export const BUILTIN_SKILL_BLUEPRINTS: SkillBlueprint[] = [];
