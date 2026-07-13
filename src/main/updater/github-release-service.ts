import type { GitHubRelease, GitHubReleaseListOptions } from "../../types/domain";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_REPO = {
  owner: "KOIAI777",
  repo: "brevyn",
};
const CACHE_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

interface ReleaseCache {
  data: GitHubRelease[];
  timestamp: number;
}

interface GitHubApiAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GitHubApiRelease {
  id?: unknown;
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: unknown;
}

let releasesCache: ReleaseCache | null = null;
const tagCache = new Map<string, { data: GitHubRelease; timestamp: number }>();
let rateLimitUntil = 0;

export async function listGitHubReleases(options: GitHubReleaseListOptions = {}): Promise<GitHubRelease[]> {
  const { perPage = 5, page = 1, includePrerelease = false } = options;

  try {
    if (page === 1 && releasesCache && Date.now() - releasesCache.timestamp < CACHE_TTL_MS) {
      return filterReleases(releasesCache.data, includePrerelease).slice(0, perPage);
    }

    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    });
    const releases = await fetchFromGitHub<GitHubApiRelease[]>(`/releases?${params.toString()}`);
    const normalized = releases.map(normalizeRelease);
    if (page === 1) releasesCache = { data: normalized, timestamp: Date.now() };
    return filterReleases(normalized, includePrerelease);
  } catch (error) {
    console.warn("[brevyn-updater] Failed to load GitHub releases", error);
    if (!releasesCache) return [];
    return filterReleases(releasesCache.data, includePrerelease).slice(0, perPage);
  }
}

export async function getGitHubReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  const normalizedTag = tag.startsWith("v") ? tag : `v${tag}`;
  const cached = tagCache.get(normalizedTag);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  try {
    const release = normalizeRelease(await fetchFromGitHub<GitHubApiRelease>(`/releases/tags/${encodeURIComponent(normalizedTag)}`));
    tagCache.set(normalizedTag, { data: release, timestamp: Date.now() });
    return release;
  } catch (error) {
    console.warn(`[brevyn-updater] Failed to load GitHub release ${normalizedTag}`, error);
    return cached?.data ?? null;
  }
}

async function fetchFromGitHub<T>(endpoint: string): Promise<T> {
  if (Date.now() < rateLimitUntil) throw new Error("GitHub API rate limit cooldown");

  const response = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Brevyn-Desktop-App",
    },
  });

  if (response.status === 403 || response.status === 429) {
    rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  }

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function filterReleases(releases: GitHubRelease[], includePrerelease: boolean): GitHubRelease[] {
  return releases.filter((release) => !release.draft && (includePrerelease || !release.prerelease));
}

function normalizeRelease(release: GitHubApiRelease): GitHubRelease {
  const assets = (Array.isArray(release.assets) ? release.assets : []) as GitHubApiAsset[];
  return {
    id: numberValue(release.id),
    tagName: stringValue(release.tag_name),
    name: stringValue(release.name),
    body: stringValue(release.body),
    htmlUrl: stringValue(release.html_url),
    publishedAt: stringValue(release.published_at),
    prerelease: Boolean(release.prerelease),
    draft: Boolean(release.draft),
    assets: assets.map(normalizeAsset),
  };
}

function normalizeAsset(asset: GitHubApiAsset): GitHubRelease["assets"][number] {
  return {
    name: stringValue(asset.name),
    browserDownloadUrl: stringValue(asset.browser_download_url),
    size: numberValue(asset.size),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
