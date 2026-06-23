import { loadConfig } from '../src/config.js';
import { readAlignmentReportForExistingCase } from '../src/commonGroundAutomation.js';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const caseId = argValue('--case-id');
  if (!caseId) {
    console.error('Usage: node scripts/readAlignmentReport.js --case-id CG-0301 --case-type "Performance Review - Coaching" [--headed]');
    process.exit(1);
  }

  const config = loadConfig(process.argv.slice(2));
  const caseType = argValue('--case-type') ?? config.run.caseType;

  console.log(`Reading alignment report for ${caseId} (${caseType})...`);
  const result = await readAlignmentReportForExistingCase(config, { caseId, caseType });

  console.log('----------------------------------------');
  console.log('Score read:           ', result.score ?? 'NOT DETECTED');
  console.log('Report URL:           ', result.url);
  console.log('Expected range:       ', JSON.stringify(result.expectedRange));
  console.log('Within expected range:', result.withinExpectedRange);
  console.log('Elapsed (s):          ', Math.round((result.elapsedMs ?? 0) / 1000));
  console.log('----------------------------------------');
  console.log('Visible report text (first 1000 chars):');
  console.log(String(result.visibleText ?? '').slice(0, 1000));

  process.exit(result.score == null ? 2 : 0);
}

main().catch((error) => {
  console.error('Failed to read alignment report:', error.message);
  process.exit(1);
});
