import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createRunStore(rootDir) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(rootDir, 'results', runId);
  await fs.mkdir(runDir, { recursive: true });

  return {
    runId,
    runDir,
    caseStore(caseNumber) {
      const caseDir = path.join(runDir, `case-${String(caseNumber).padStart(3, '0')}`);
      fsSync.mkdirSync(caseDir, { recursive: true });
      return {
        runId,
        runDir: caseDir,
        async writeJson(name, data) {
          await fs.mkdir(caseDir, { recursive: true });
          await fs.writeFile(path.join(caseDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        },
        async writeText(name, text) {
          await fs.mkdir(caseDir, { recursive: true });
          await fs.writeFile(path.join(caseDir, name), text, 'utf8');
        }
      };
    },
    async writeJson(name, data) {
      await fs.writeFile(path.join(runDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    },
    async writeText(name, text) {
      await fs.writeFile(path.join(runDir, name), text, 'utf8');
    }
  };
}
