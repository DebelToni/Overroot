import { Link } from 'react-router-dom';

export function Brand({ subtitle = 'Collaborative LaTeX studio', compact = false }: { subtitle?: string; compact?: boolean }) {
  return (
    <Link to="/" className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="Overroot home">
      <span className="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 32 32"><path d="M23.5 6.5C14 7.5 8.5 13 8.5 20c0 3.4 2.3 6 5.5 6 7.8 0 11.7-10 9.5-19.5Z"/><path className="brand__vein" d="M11 24c3.5-5 7-9 11-13"/></svg>
      </span>
      <span className="brand__copy">
        <strong>Overroot</strong>
        {!compact && <small>{subtitle}</small>}
      </span>
    </Link>
  );
}
