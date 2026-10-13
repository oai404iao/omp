import type { ResolvedModelProfile } from "@oai404iao/pi-codex-runtime/internal/model-catalog/types";

// Exact bundled hashes at 7edbf751, after 5a314017 alignment, and after catalog cleanup.
// Pin both ends: future profile changes require a fresh compatibility review.
const reviewedProfiles: Record<string, readonly [string, string, string]> = {
	"openai/gpt-5.6-sol": ["3ffd88597175e11a", "6cb0962048490234", "ca494cf82f19d13c"],
	"openai/gpt-6.1-sol": ["3ffd88597175e11a", "6cb0962048490234", "ca494cf82f19d13c"],
	"openai/gpt-5.6-terra": ["3ffd88597175e11a", "684fb3bd165b4364", "4e248e2fbc560038"],
	"openai/gpt-5.6-luna": ["3ffd88597175e11a", "684fb3bd165b4364", "4e248e2fbc560038"],
	"openai/gpt-5.5": ["0170ea402464164e", "0121c311a15cd358", "6e4ad1e55781fd74"],
	"openai/gpt-5.4": ["e020eb8c2dfe85f6", "e1d625d42c91b055", "7184c9573c20d378"],
	"openai/gpt-5.4-mini": ["f7b3b324c901e15d", "332533df2b8142aa", "49618d1041eae5e8"],
	"openai/gpt-5.2": ["46448b062babfe16", "91ef9c281a8a9fd4", "0b5f2bda5a3d6bb2"],
	"openai/codex-auto-review": ["f7b3b324c901e15d", "332533df2b8142aa", "49618d1041eae5e8"],
	"openai/gpt-5": ["a683eac101e69e40", "f65c8b1a90f592ba", "737b5cac503149ce"],
	"openai/gpt-5-mini": ["46448b062babfe16", "91ef9c281a8a9fd4", "0b5f2bda5a3d6bb2"],
	"openai/gpt-5.1": ["a683eac101e69e40", "f65c8b1a90f592ba", "737b5cac503149ce"],
	"openai/gpt-5.1-codex": ["a683eac101e69e40", "f65c8b1a90f592ba", "737b5cac503149ce"],
	"openai/gpt-5.3-codex": ["f7b3b324c901e15d", "332533df2b8142aa", "49618d1041eae5e8"],
	"openai-codex/gpt-5.6-sol": ["edf3dad13ceaa4d6", "848ea196a09d3ab0", "6ed90ecabea9b8bf"],
	"openai-codex/gpt-6-sol": ["cadfaef369d49300", "372ef25b035a56bb", "79b762db68178a02"],
	"openai-codex/gpt-6-luna": ["cadfaef369d49300", "372ef25b035a56bb", "79b762db68178a02"],
	"openai-codex/gpt-6-astra": ["edf3dad13ceaa4d6", "848ea196a09d3ab0", "6ed90ecabea9b8bf"],
	"openai-codex/gpt-5.6-terra": ["edf3dad13ceaa4d6", "7666ef477e06833e", "b4e138126aa10f5f"],
	"openai-codex/gpt-5.6-luna": ["edf3dad13ceaa4d6", "7666ef477e06833e", "b4e138126aa10f5f"],
	"openai-codex/gpt-5.5": ["9e7f4d6833f6fa90", "977f83e16ab2bbff", "53799230e8ba5f76"],
	"openai-codex/gpt-5.4": ["ffd0ddaf49ad4cbf", "6f61d2933d73bfc1", "f00d72db4938fd6e"],
	"openai-codex/gpt-5.4-mini": ["1dcd3a7974c50447", "d1a459d86fc49595", "bb47ddcde46a5735"],
	"openai-codex/gpt-5.2": ["cf9d2786d1ce5bb7", "612c070f776a1741", "d788b58cccba0816"],
	"openai-codex/codex-auto-review": ["1dcd3a7974c50447", "d1a459d86fc49595", "bb47ddcde46a5735"],
	"openai-codex/gpt-5": ["3d1dde891d4bd92b", "7c181bf37d1b3014", "d9d10586ac246d0f"],
	"openai-codex/gpt-5-mini": ["cf9d2786d1ce5bb7", "612c070f776a1741", "d788b58cccba0816"],
	"openai-codex/gpt-5.1": ["3d1dde891d4bd92b", "7c181bf37d1b3014", "d9d10586ac246d0f"],
	"openai-codex/gpt-5.1-codex": ["3d1dde891d4bd92b", "7c181bf37d1b3014", "d9d10586ac246d0f"],
	"openai-codex/gpt-5.3-codex": ["1dcd3a7974c50447", "d1a459d86fc49595", "bb47ddcde46a5735"],
};

export function matchesCheckpointProfile(profile: ResolvedModelProfile | undefined, hash: string): boolean {
	if (!profile) return false;
	if (profile.profileHash === hash) return true;
	if (profile.sources.length !== 1 || profile.sources[0] !== "bundled") return false;
	const reviewed = reviewedProfiles[profile.id];
	if (!reviewed) return false;
	const [oldestHash, previousHash, currentHash] = reviewed;
	return (hash === oldestHash || hash === previousHash) && profile.profileHash === currentHash;
}
