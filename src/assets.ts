import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const bundledPackageId = '28dfdd1d90c99f39342f781edd003826f37909f5aa061a2aede63a37ba8085eb';
export const bundledPackageName = 'canton-failover-receipts';
export const bundledDarSha256 = '1a4ae0b0a1da636a2a0db687437b8bc8748bfe09365cbdaec948c3fd274b5cb9';
export const bundledDarPath = fileURLToPath(new URL('../contracts/artifacts/canton-failover-receipts-0.1.0.dar', import.meta.url));
export function bundledDarVerified(): boolean {
  return existsSync(bundledDarPath) && createHash('sha256').update(readFileSync(bundledDarPath)).digest('hex') === bundledDarSha256;
}
