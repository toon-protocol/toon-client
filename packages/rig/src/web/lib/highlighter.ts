import type { HighlighterCore } from 'shiki/core';

let highlighterPromise: Promise<HighlighterCore> | null = null;

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'toml',
  nix: 'bash',
  env: 'bash',
  conf: 'bash',
  cfg: 'bash',
  ini: 'bash',
  dockerfile: 'bash',
  xml: 'html',
  svg: 'html',
};

/** Map of full filenames to language (for dotfiles and extensionless files) */
const NAME_TO_LANG: Record<string, string> = {
  dockerfile: 'bash',
  '.dockerignore': 'bash',
  '.gitignore': 'bash',
  '.env': 'bash',
  '.env.example': 'bash',
  '.npmrc': 'bash',
  makefile: 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
};

export function detectLanguage(filename: string): string | null {
  const lower = filename.toLowerCase();
  const byName = NAME_TO_LANG[lower];
  if (byName) return byName;

  const ext = lower.split('.').pop();
  if (!ext) return null;
  return EXT_TO_LANG[ext] ?? null;
}

async function createHighlighter(): Promise<HighlighterCore> {
  const { createHighlighterCore } = await import('shiki/core');
  const { createOnigurumaEngine } = await import('shiki/engine/oniguruma');

  const [js, ts, json, html, css, md, py, go, rust, yaml, bash, sql, toml] =
    await Promise.all([
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/go.mjs'),
      import('shiki/langs/rust.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/toml.mjs'),
    ]);

  return createHighlighterCore({
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ],
    langs: [
      js.default,
      ts.default,
      json.default,
      html.default,
      css.default,
      md.default,
      py.default,
      go.default,
      rust.default,
      yaml.default,
      bash.default,
      sql.default,
      toml.default,
    ],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
}

export async function highlight(
  code: string,
  lang: string | null
): Promise<string> {
  if (!lang) return escapeForHtml(code);

  if (!highlighterPromise) {
    highlighterPromise = createHighlighter();
  }

  try {
    const highlighter = await highlighterPromise;
    return highlighter.codeToHtml(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
    });
  } catch {
    return escapeForHtml(code);
  }
}

function escapeForHtml(text: string): string {
  return `<pre><code>${text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</code></pre>`;
}
