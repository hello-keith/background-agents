/**
 * Source control manager URL utilities.
 *
 * Generates GitHub URLs for repos and branches.
 */

const GITHUB_BASE_URL = "https://github.com";

export function getScmRepoUrl(owner: string, name: string): string {
  return `${GITHUB_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function getScmBranchUrl(owner: string, name: string, branch: string): string {
  const encodedOwner = encodeURIComponent(owner);
  const encodedName = encodeURIComponent(name);
  const encodedBranch = encodeURIComponent(branch);
  return `${GITHUB_BASE_URL}/${encodedOwner}/${encodedName}/tree/${encodedBranch}`;
}
