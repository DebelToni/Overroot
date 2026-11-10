import { posterTemplateFiles } from './poster-template-files.js';
import { posterThemes } from './posters.js';

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  entryFile: string;
  files: Record<string, string>;
}

export const projectTemplates: ProjectTemplate[] = [
  {
    id: 'article',
    name: 'Article',
    description: 'A clean article with common math and graphics packages.',
    entryFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,graphicx,hyperref}

\title{Untitled article}
\author{}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here.

\end{document}
`
    }
  },
  {
    id: 'report',
    name: 'Report',
    description: 'A structured report with chapters and a table of contents.',
    entryFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[11pt]{report}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,graphicx,hyperref}

\title{Untitled report}
\author{}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\chapter{Introduction}
Start writing here.

\end{document}
`
    }
  },
  {
    id: 'beamer',
    name: 'Presentation',
    description: 'A minimal Beamer presentation.',
    entryFile: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass{beamer}
\usetheme{default}

\title{Untitled presentation}
\author{}
\date{\today}

\begin{document}
\frame{\titlepage}

\begin{frame}{First frame}
  Add your content here.
\end{frame}

\end{document}
`
    }
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'The smallest compilable LaTeX document.',
    entryFile: 'main.tex',
    files: {
      'main.tex': '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n'
    }
  },
  ...posterThemes.map((theme) => ({
    id: theme,
    name: ({ 'academic-classic': 'Academic Classic poster', 'modern-ml': 'Modern ML poster', 'visual-results': 'Visual Results poster' })[theme],
    description: 'A large-format research poster with modular sections and a print-ready page.',
    entryFile: 'poster.tex',
    files: posterTemplateFiles[theme]!
  }))
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return projectTemplates.find((template) => template.id === id);
}
