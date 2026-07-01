// Quick OpenAI connectivity check without a full automation run.
// Usage: npm run preflight  (routes through scripts/launch.js so the local
// intercepting-proxy CA is applied — see config/certs/README.md)
import dotenv from 'dotenv';
import { verifyOpenAiConnectivity } from '../src/llmResponder.js';

dotenv.config();

const llm = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
};

console.log(`Preflight: model=${llm.model}, NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS ?? '(not set)'}`);

try {
  await verifyOpenAiConnectivity(llm);
  console.log('OpenAI connectivity OK.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
