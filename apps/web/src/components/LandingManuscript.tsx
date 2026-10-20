import { useId, useState } from 'react';
import './LandingManuscript.css';

const manuscript = {
  title: 'A note on collaboration',
  abstract: 'A shared manuscript makes room for ideas, discussion, and revision.',
  introduction: 'Start with an outline. Build one section at a time.',
  results: 'Read the sections together. Review each change in context.'
};

const sourceFiles = [
  {
    path: 'main.tex',
    content: String.raw`\documentclass{article}
\title{${manuscript.title}}
\date{}
\begin{document}
\maketitle
\begin{abstract}
${manuscript.abstract}
\end{abstract}
\input{sections/introduction}
\input{sections/results}
\end{document}`
  },
  { path: 'sections/introduction.tex', content: String.raw`\section{Introduction}
${manuscript.introduction}` },
  { path: 'sections/results.tex', content: String.raw`\section{Review}
${manuscript.results}` }
];

/** A small, local example of one manuscript backed by modular LaTeX files. */
export function LandingManuscript() {
  const [view, setView] = useState<'manuscript' | 'sources'>('manuscript');
  const [sourceIndex, setSourceIndex] = useState(0);
  const id = useId();
  const source = sourceFiles[sourceIndex]!;

  return <section className="landing-manuscript" aria-label="Example manuscript">
    <div className="landing-manuscript__toolbar">
      <span className="landing-manuscript__label">Example manuscript</span>
      <div className="landing-manuscript__views" role="group" aria-label="Example view">
        <button type="button" aria-pressed={view === 'manuscript'} aria-controls={`${id}-preview`} onClick={() => setView('manuscript')}>Paper</button>
        <button type="button" aria-pressed={view === 'sources'} aria-controls={`${id}-preview`} onClick={() => setView('sources')}>Sources</button>
      </div>
    </div>
    <div id={`${id}-preview`} className="landing-manuscript__preview">
      {view === 'manuscript'
        ? <article className="landing-manuscript__paper" aria-label="Sample article">
          <h2>{manuscript.title}</h2>
          <div className="landing-manuscript__abstract"><h3>Abstract</h3><p>{manuscript.abstract}</p></div>
          <div className="landing-manuscript__sections">
            <section><h3>1. Introduction</h3><p>{manuscript.introduction}</p></section>
            <section><h3>2. Review</h3><p>{manuscript.results}</p></section>
          </div>
        </article>
        : <div className="landing-manuscript__sources">
          <label className="landing-manuscript__file"><span>File</span><select aria-label="Example source file" value={sourceIndex} onChange={(event) => setSourceIndex(Number(event.target.value))}>
            {sourceFiles.map((file, index) => <option key={file.path} value={index}>{file.path}</option>)}
          </select></label>
          <pre className="landing-manuscript__code" tabIndex={0} aria-label={`${source.path} source`}><code>{source.content}</code></pre>
        </div>}
    </div>
  </section>;
}
