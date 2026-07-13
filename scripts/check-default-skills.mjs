import { updateDefaultSkillLock, validateDefaultSkillLock } from "./default-skill-lock.mjs";

try {
  if (process.argv.includes("--write")) {
    const state = updateDefaultSkillLock();
    console.log(`Updated default Skill version lock for ${Object.keys(state.skills).length} Skills.`);
  } else {
    const state = validateDefaultSkillLock();
    console.log(`Validated ${Object.keys(state.skills).length} default Skill versions.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
