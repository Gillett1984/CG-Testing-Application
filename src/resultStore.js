import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Write via a temp file + atomic rename so an interrupted write (crash, Ctrl-C,
// power loss) never leaves a truncated/corrupt artifact. Matters most for the
// batch summary, which is now rewritten after every case.
async function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function createRunStore(rootDir, options = {}) {
  // Reuse an existing runId (dir) when resuming; otherwise stamp a new one.
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
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
          await writeFileAtomic(path.join(caseDir, name), `${JSON.stringify(data, null, 2)}\n`);
        },
        async writeText(name, text) {
          await fs.mkdir(caseDir, { recursive: true });
          await writeFileAtomic(path.join(caseDir, name), text);
        }
      };
    },
    async readJson(name) {
      return readJsonIfPresent(path.join(runDir, name));
    },
    async writeJson(name, data) {
      await writeFileAtomic(path.join(runDir, name), `${JSON.stringify(data, null, 2)}\n`);
    },
    async writeText(name, text) {
      await writeFileAtomic(path.join(runDir, name), text);
    }
  };
}
