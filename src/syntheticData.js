export function buildSyntheticCase({ topic, caseType, participantEmail }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shortId = Math.random().toString(36).slice(2, 8).toUpperCase();

  return {
    caseType: caseType ?? topic,
    participantName: `Synthetic Participant ${shortId}`,
    requestorName: `Synthetic Employee ${shortId}`,
    title: `SYNTHETIC TEST DATA - ${topic} - ${stamp}`,
    topic,
    participantEmail,
    reference: `CG-AI-TEST-${shortId}`,
    summary: [
      'SYNTHETIC TEST DATA.',
      'This automated case is for Partner AI Getting Started behavior testing.',
      'No real people, events, disputes, addresses, or contact details are represented.',
      `Scenario topic: ${topic}.`
    ].join(' ')
  };
}

export function buildFallbackResponse({ topic, latestPrompt, turn }) {
  throw new Error('Hardcoded synthetic fallback responses have been disabled. Configure OPENAI_API_KEY so responses are generated from the latest Partner AI prompt.');
}
