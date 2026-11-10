import { describe, expect, it } from 'vitest';
import { posterDimensions, posterFiles, posterOptionsSchema, posterThemes } from '../src/posters.js';

describe('poster project templates', () => {
  it.each(posterThemes)('creates a modular %s poster with one configured entry file', (theme) => {
    const files = posterFiles(theme, 'Results & Methods', {
      subtitle: 'A study', authors: 'A. Researcher', affiliation: 'Example Institute',
      size: 'A1', orientation: 'landscape', columns: 2
    });
    expect(files['poster.tex']).toContain('\\RequirePackage{fix-cm}');
    expect(files['poster.tex']).toContain('\\input{config.tex}');
    expect(files['OVERPOSTER-LICENSE.txt']).toContain('Copyright (c) 2026 Overposter contributors');
    expect(files['OVERPOSTER-LICENSE.txt']).toContain('Permission is hereby granted');
    expect(files['poster-layout.tex']).toContain('\\newcommand{\\PosterGrid}');
    expect(files['sections/results.tex']).toBeTruthy();
    expect(files['config.tex']).toContain('\\def\\PosterWidth{841}');
    expect(files['config.tex']).toContain('\\def\\PosterHeight{594}');
    expect(files['config.tex']).toContain('Results \\& Methods');
    expect(files['config.tex']).not.toContain('\\write18');
  });

  it('escapes TeX metadata and flattens paragraph breaks inside macro definitions', () => {
    const files = posterFiles('academic-classic', 'A\\input{x} & 50%\n\nnext', posterOptionsSchema.parse({ authors: '#1_${x}^~\\' }));
    expect(files['config.tex']).toContain('A\\textbackslash{}input\\{x\\} \\& 50\\% next');
    expect(files['config.tex']).toContain('\\#1\\_\\$\\{x\\}\\textasciicircum{}\\textasciitilde{}\\textbackslash{}');
  });

  it('supports A0 portrait and bounded custom print dimensions', () => {
    expect(posterDimensions(posterOptionsSchema.parse({ size: 'A0', orientation: 'portrait' })))
      .toEqual({ widthMm: 841, heightMm: 1189 });
    expect(posterDimensions(posterOptionsSchema.parse({ size: 'custom', widthMm: 1000, heightMm: 700 })))
      .toEqual({ widthMm: 1000, heightMm: 700 });
    expect(() => posterOptionsSchema.parse({ size: 'custom', widthMm: 4000, heightMm: 700 })).toThrow();
    expect(() => posterOptionsSchema.parse({ size: 'custom', widthMm: 700 })).toThrow();
  });
});
