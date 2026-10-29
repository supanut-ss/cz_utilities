import { ExternalLink, GitBranch } from 'lucide-react';

function getGithubRepoUrl(value) {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash || segments.length !== 2) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function RepositoryLink({ originRepo, skillName }) {
  const url = getGithubRepoUrl(originRepo?.url);
  if (!url) return null;

  return <a className="repo-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={`เปิด GitHub repository ของ ${skillName}`} title={url}>
    <GitBranch size={13} />Repo
  </a>;
}

export function RepositoryOrigin({ originRepo }) {
  const url = getGithubRepoUrl(originRepo?.url);
  if (!url) return null;

  return <section className="repository-origin" aria-label="ที่มา GitHub repository">
    <div className="repository-origin-content">
      <div className="repository-origin-title"><GitBranch size={15} /><strong>ที่มา: GitHub repository</strong></div>
      <a className="repository-origin-url" href={url} target="_blank" rel="noopener noreferrer">{url}<ExternalLink size={13} /></a>
      <div className="repository-origin-meta">
        {originRepo.ref && <span>อ้างอิง: {originRepo.ref}</span>}
        {originRepo.commit && <span>Commit: <code>{originRepo.commit.slice(0, 12)}</code></span>}
        {originRepo.subpath && <span>โฟลเดอร์: <code>{originRepo.subpath}</code></span>}
      </div>
    </div>
  </section>;
}
