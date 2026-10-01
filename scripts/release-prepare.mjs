import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertPackContents, npm, packageMetadata, root } from './smoke-utils.mjs';
import { requireSupportedNode } from './runtime.mjs';

requireSupportedNode();
const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${packageMetadata.version}`) {
  throw new Error(`Release tag must match package version v${packageMetadata.version}`);
}
const out = resolve(values.out ?? join(root, 'release'));
mkdirSync(out, { recursive: true });
const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', out], root));
assertPackContents(packed.files);
const digest = createHash('sha256').update(readFileSync(join(out, packed.filename))).digest('hex');
writeFileSync(join(out, 'SHA256SUMS'), `${digest}  ${packed.filename}\n`);
console.log(JSON.stringify({ version: packageMetadata.version, archive: join(out, packed.filename), sha256: digest, checksums: join(out, 'SHA256SUMS') }, null, 2));
