/** Archive SHA-256 values from https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json. */
const release = {
  darwin: {
    aarch64: '123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845',
    x86_64: '92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06',
  },
  linux: {
    aarch64: 'e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb',
    x86_64: '99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852',
  },
  windows: {
    aarch64: '8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab',
    x86_64: '5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6',
  },
} as const

/** A version can run only after its registry digests are reviewed and included here. */
export function officialArchiveDigest(
  version: string, platform: keyof typeof release, arch: keyof typeof release.linux,
): string | undefined {
  return version === '1.5.2' ? release[platform][arch] : undefined
}
