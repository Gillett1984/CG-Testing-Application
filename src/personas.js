import fs from 'node:fs';
import path from 'node:path';
import { personaCatalogSchema, personaRotationSchema } from './scenarioSchemas.js';

export function loadPersonaCatalog(rootDir) {
  const p = path.resolve(rootDir, 'config/personas/catalog.json');
  if (!fs.existsSync(p)) return null;
  return personaCatalogSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
}

export function loadPersonaRotation(rootDir, relativePath = 'config/personas/default-rotation.json') {
  const p = path.resolve(rootDir, relativePath);
  if (!fs.existsSync(p)) return null;
  return personaRotationSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
}

// Selection is keyed STRICTLY to caseNumber (1-based) — never store.runId or
// scenarioSeed — so a batch deterministically cycles through personas and no two
// cases in a run collapse onto the same one.
export function selectPersona({ catalog, plan, pinnedId, enabled, caseNumber }) {
  if (!enabled || !catalog) return null;
  const byId = new Map(catalog.personas.map((persona) => [persona.id, persona]));
  if (pinnedId) {
    const pinned = byId.get(pinnedId);
    if (!pinned) throw new Error(`Unknown persona id "${pinnedId}". Known: ${[...byId.keys()].join(', ')}.`);
    return pinned;
  }
  if (!plan?.personaIds?.length) return null;
  const index = (Math.max(1, caseNumber) - 1) % plan.personaIds.length;
  const persona = byId.get(plan.personaIds[index]);
  if (!persona) throw new Error(`Persona rotation references unknown id "${plan.personaIds[index]}".`);
  return persona;
}
