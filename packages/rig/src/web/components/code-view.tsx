import { useState, useEffect, useRef } from 'react';
import { highlight, detectLanguage } from '@/lib/highlighter';

interface CodeViewProps {
  text: string;
  filename: string;
}

/**
 * Code view with line numbers and clickable line highlighting.
 * Uses DOM manipulation for line highlighting to avoid React re-renders
 * of the entire table on every click.
 */
export function CodeView({ text, filename }: CodeViewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const activeRef = useRef<number | null>(null);

  // Highlight code
  useEffect(() => {
    const lang = detectLanguage(filename);
    highlight(text, lang).then((result) => {
      // Extract per-line spans from Shiki output
      const codeMatch = result.match(/<code[^>]*>([\s\S]*?)<\/code>/);
      if (!codeMatch) {
        setHtml(buildPlainTable(text));
        return;
      }
      const inner = codeMatch[1] ?? '';
      const lineSpans = inner.split(/<span class="line">/);
      const extracted = lineSpans
        .map((s) => s.replace(/<\/span>$/, '').trim())
        .filter((s) => s !== '');

      const lineHtmls = extracted.length > 0 ? extracted : inner.split('\n');
      setHtml(buildTable(lineHtmls));
    }).catch(() => {
      setHtml(buildPlainTable(text));
    });
  }, [text, filename]);

  // Handle line clicks via event delegation (no React re-renders)
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const td = target.closest('td.line-num');
      if (!td) return;

      const lineNum = parseInt(td.getAttribute('data-line') ?? '', 10);
      if (isNaN(lineNum)) return;

      // Remove previous highlight
      if (activeRef.current !== null) {
        table?.querySelector(`tr.line-active`)?.classList.remove('line-active');
      }

      // Toggle or set new
      if (activeRef.current === lineNum) {
        activeRef.current = null;
      } else {
        const row = td.closest('tr');
        row?.classList.add('line-active');
        activeRef.current = lineNum;
      }
    }

    table.addEventListener('click', handleClick);
    return () => table.removeEventListener('click', handleClick);
  }, [html]);

  if (!html) {
    return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table
        ref={tableRef}
        className="code-table w-full border-collapse text-[13px] leading-5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function buildTable(lineHtmls: string[]): string {
  return '<tbody>' + lineHtmls.map((lineHtml, i) => {
    const num = i + 1;
    return `<tr><td class="line-num" data-line="${num}">${num}</td><td class="line-code"><span class="shiki-line">${lineHtml || '&nbsp;'}</span></td></tr>`;
  }).join('') + '</tbody>';
}

function buildPlainTable(text: string): string {
  const lines = text.split('\n');
  return '<tbody>' + lines.map((line, i) => {
    const num = i + 1;
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<tr><td class="line-num" data-line="${num}">${num}</td><td class="line-code">${escaped || '&nbsp;'}</td></tr>`;
  }).join('') + '</tbody>';
}
