export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 10);
}

export function requireSupportedNode() {
  if (supportedNode()) return;
  console.error(`Canton failover requires Node.js 24.10 or newer. Current: ${process.versions.node}. Install Node.js 24 LTS and retry.`);
  process.exit(1);
}
