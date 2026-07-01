import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Resolves the extra CA certificate needed when local TLS-intercepting
 * software (e.g. Norton Web/Mail Shield) re-signs outbound HTTPS traffic.
 *
 * Candidate order (first existing file wins):
 * 1. EXTRA_CA_CERTS_PATH env var (explicit override, set in .env)
 * 2. An already-set NODE_EXTRA_CA_CERTS, but only if the file still exists
 *    (self-heals stale values that would otherwise be silently kept)
 * 3. config/certs/norton-root.pem (stable local location)
 * 4. .tmp/norton-root.pem (legacy location)
 *
 * Returns { env, caPath, source } — env is a copy of the input env with
 * NODE_EXTRA_CA_CERTS set (or removed if no candidate exists).
 */
export function resolveCaEnv(rootDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const candidates = [
    { source: 'EXTRA_CA_CERTS_PATH', value: env.EXTRA_CA_CERTS_PATH },
    { source: 'NODE_EXTRA_CA_CERTS', value: env.NODE_EXTRA_CA_CERTS },
    { source: 'config/certs/norton-root.pem', value: path.join(rootDir, 'config', 'certs', 'norton-root.pem') },
    { source: '.tmp/norton-root.pem (legacy)', value: path.join(rootDir, '.tmp', 'norton-root.pem') }
  ];

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const resolved = path.isAbsolute(candidate.value) ? candidate.value : path.resolve(rootDir, candidate.value);
    if (fsSync.existsSync(resolved)) {
      env.NODE_EXTRA_CA_CERTS = resolved;
      return { env, caPath: resolved, source: candidate.source };
    }
  }

  delete env.NODE_EXTRA_CA_CERTS;
  return { env, caPath: null, source: null };
}

export function describeCaEnv(resolution) {
  if (!resolution.caPath) return 'No extra CA certificate found (NODE_EXTRA_CA_CERTS not set).';
  return `Using NODE_EXTRA_CA_CERTS=${resolution.caPath} (via ${resolution.source})`;
}
