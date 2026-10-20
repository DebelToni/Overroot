import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LandingManuscript } from './LandingManuscript';

afterEach(cleanup);

it('opens a readable example manuscript and exposes the selected view accessibly', () => {
  render(<LandingManuscript/>);
  const example = screen.getByRole('region', { name: 'Example manuscript' });
  const views = within(example).getByRole('group', { name: 'Example view' });
  expect(within(views).getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(views).getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-pressed', 'false');
  expect(within(example).getByRole('heading', { name: 'A note on collaboration' })).toBeInTheDocument();
  expect(within(example).getByRole('heading', { name: 'Abstract' })).toBeInTheDocument();
  expect(within(example).getByRole('heading', { name: '1. Introduction' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Example source file' })).not.toBeInTheDocument();
});

it('switches to real modular LaTeX sources and lets the reader inspect each referenced section', () => {
  render(<LandingManuscript/>);
  fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
  expect(screen.getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'false');
  const main = screen.getByLabelText('main.tex source');
  expect(main).toHaveTextContent(String.raw`\documentclass{article}`);
  expect(main).toHaveTextContent(String.raw`\title{A note on collaboration}`);
  expect(main).toHaveTextContent(String.raw`\input{sections/introduction}`);
  expect(main).toHaveTextContent(String.raw`\input{sections/results}`);
  expect(main).toHaveTextContent(String.raw`\end{document}`);
  const files = screen.getByRole('combobox', { name: 'Example source file' });
  expect(within(files).getByRole('option', { name: 'sections/introduction.tex' })).toBeInTheDocument();
  expect(within(files).getByRole('option', { name: 'sections/results.tex' })).toBeInTheDocument();
  fireEvent.change(files, { target: { value: '1' } });
  expect(screen.getByLabelText('sections/introduction.tex source')).toHaveTextContent(String.raw`\section{Introduction}`);
  expect(screen.getByLabelText('sections/introduction.tex source')).toHaveTextContent('Start with an outline');
  fireEvent.change(files, { target: { value: '2' } });
  expect(screen.getByLabelText('sections/results.tex source')).toHaveTextContent(String.raw`\section{Review}`);
  expect(screen.getByLabelText('sections/results.tex source')).toHaveTextContent('Read the sections together');
  fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
  expect(screen.getByRole('heading', { name: 'A note on collaboration' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
