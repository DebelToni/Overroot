import { Link } from 'react-router-dom';
import { RootMark } from './RootMark';

export function Brand({ subtitle = 'Collaborative LaTeX studio', compact = false }: { subtitle?: string; compact?: boolean }) {
  return (
    <Link to="/" className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="Overroot home">
      <span className="brand__mark" aria-hidden="true">
        <RootMark motion="enter"/>
      </span>
      <span className="brand__copy">
        <strong>Overroot</strong>
        {!compact && <small>{subtitle}</small>}
      </span>
    </Link>
  );
}
