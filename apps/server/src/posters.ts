import { z } from 'zod';
import { posterLicense, posterTemplateFiles } from './poster-template-files.js';

export const posterThemes = ['academic-classic', 'modern-ml', 'visual-results'] as const;
export const posterOptionsSchema = z.object({
  subtitle: z.string().trim().max(240).default(''),
  authors: z.string().trim().max(500).default(''),
  affiliation: z.string().trim().max(500).default(''),
  size: z.enum(['A0', 'A1', 'custom']).default('A1'),
  orientation: z.enum(['landscape', 'portrait']).default('landscape'),
  widthMm: z.number().int().min(200).max(3000).optional(),
  heightMm: z.number().int().min(200).max(3000).optional(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2)
}).superRefine((value, context) => {
  if (value.size === 'custom' && (!value.widthMm || !value.heightMm)) {
    context.addIssue({ code: 'custom', message: 'Custom posters need a width and height in millimetres' });
  }
});

export type PosterOptions = z.infer<typeof posterOptionsSchema>;

export function isPosterTheme(value: string): value is typeof posterThemes[number] {
  return posterThemes.some((theme) => theme === value);
}

export function posterDimensions(options: PosterOptions): { widthMm: number; heightMm: number } {
  if (options.size === 'custom') return { widthMm: options.widthMm!, heightMm: options.heightMm! };
  const short = options.size === 'A0' ? 841 : 594;
  const long = options.size === 'A0' ? 1189 : 841;
  return options.orientation === 'landscape'
    ? { widthMm: long, heightMm: short }
    : { widthMm: short, heightMm: long };
}

function texEscape(value: string): string {
  const chars: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '$': '\\$',
    '&': '\\&', '#': '\\#', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}'
  };
  return value.replace(/\s+/g, ' ').replace(/[\\{}%$&#_^~]/g, (character) => chars[character]!);
}

export function posterFiles(theme: typeof posterThemes[number], title: string, input?: PosterOptions): Record<string, string> {
  const options = posterOptionsSchema.parse(input ?? {});
  const { widthMm, heightMm } = posterDimensions(options);
  const source = posterTemplateFiles[theme]!;
  const config = [
    `% Poster settings. Edit this file to change the print size and metadata.`,
    `\\def\\PosterWidth{${widthMm}}`,
    `\\def\\PosterHeight{${heightMm}}`,
    `\\def\\PosterTitle{${texEscape(title)}}`,
    `\\def\\PosterSubtitle{${texEscape(options.subtitle)}}`,
    `\\def\\PosterAuthors{${texEscape(options.authors)}}`,
    `\\def\\PosterAffiliation{${texEscape(options.affiliation)}}`,
    `\\def\\PosterContact{}`, `\\def\\PosterPaperURL{}`,
    `\\def\\PosterColumns{${options.columns}}`,
    `\\def\\PosterBodySize{27}`, `\\def\\PosterBodyLeading{35}`,
    `\\def\\PosterHeadingSize{40}`, `\\def\\PosterTitleSize{68}`,
    ''
  ].join('\n');
  return { ...source, 'config.tex': config, 'OVERPOSTER-LICENSE.txt': posterLicense };
}
