export const ROM_REPO = {
  owner: 'camarguin',
  repo: 'snes-roms',
  branch: 'main',
}

export function romFileUrl(file: string): string {
  const path = encodeURIComponent(file).replace(/%2F/g, '/')
  return `https://raw.githubusercontent.com/${ROM_REPO.owner}/${ROM_REPO.repo}/${ROM_REPO.branch}/${path}`
}

export function manifestUrl(): string {
  return romFileUrl('manifest.json')
}
