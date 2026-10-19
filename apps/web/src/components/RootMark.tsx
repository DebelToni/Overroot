const roots = [
  { branch: 'stem', d: 'M16 4v9c0 5-2 8-2 15' },
  { branch: 'main', d: 'M16 11c-2 4-6 4-9 7l-3 3M16 13c2 4 7 4 10 8l2 2' },
  { branch: 'fine', d: 'M10 16v5l-3 5M7 18H4M22 18v6l3 4M25 20l3-1M15 21l-5 7M18 17l1 7' }
];

/** A shared root symbol; motion is decorative and never delays an action. */
export function RootMark({ motion = 'none' }: { motion?: 'none' | 'enter' | 'grow' }) {
  return <svg className={`root-mark root-mark--${motion}`} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <g className="root-mark__trace">{roots.map(({ branch, d }) => <path key={branch} d={d}/>)}</g>
    <g className="root-mark__growth">{roots.map(({ branch, d }) => <path key={branch} className={`root-mark__${branch}`} pathLength="1" d={d}/>)}</g>
  </svg>;
}

export function PendingLabel({ children }: { children: string }) {
  return <span className="pending-label" role="status"><RootMark motion="grow"/><span>{children}</span></span>;
}
