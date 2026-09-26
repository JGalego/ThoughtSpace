import { useMemo } from 'react';
import katex from 'katex';

export function Tex({ latex, display = true }: { latex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { displayMode: display, throwOnError: false });
    } catch {
      return latex;
    }
  }, [latex, display]);
  return display ? <div className="eq" dangerouslySetInnerHTML={{ __html: html }} /> : <span dangerouslySetInnerHTML={{ __html: html }} />;
}
