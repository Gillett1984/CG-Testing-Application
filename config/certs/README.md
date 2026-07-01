# Local CA certificates

This directory holds machine-specific root CA certificates needed when local
software (e.g. **Norton Antivirus "Web/Mail Shield"**) intercepts TLS and
re-signs outbound HTTPS traffic. Without the intercepting root CA, Node's
native `fetch` fails OpenAI calls with:

```
fetch failed | unable to verify the first certificate UNABLE_TO_VERIFY_LEAF_SIGNATURE
```

`.pem` files here are **gitignored** — they are specific to each machine.

## How it is used

`scripts/localCaEnv.js` resolves the first existing candidate and sets
`NODE_EXTRA_CA_CERTS` for every entry point (via `scripts/launch.js`, used by
the `ui`, `test:case`, and `preflight` npm scripts, and by the UI server when
spawning runs):

1. `EXTRA_CA_CERTS_PATH` env var (set in `.env` to override)
2. An already-set, still-valid `NODE_EXTRA_CA_CERTS`
3. `config/certs/norton-root.pem` (this directory)
4. `.tmp/norton-root.pem` (legacy location)

## Re-exporting the Norton root if it rotates

If Norton regenerates its root (e.g. after reinstall/update), export the new
one by connecting to any HTTPS site and saving the presented root:

```powershell
node -e "const tls=require('tls');const s=tls.connect({host:'api.openai.com',port:443,rejectUnauthorized:false},()=>{let c=s.getPeerCertificate(true);while(c.issuerCertificate&&c.issuerCertificate!==c)c=c.issuerCertificate;console.log('-----BEGIN CERTIFICATE-----');console.log(c.raw.toString('base64').match(/.{1,64}/g).join('\n'));console.log('-----END CERTIFICATE-----');s.end();})" > config/certs/norton-root.pem
```

Verify it works with `npm run preflight`.
