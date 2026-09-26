// The command surface: natural language plus the current selection as "this".
// The transcript is an interaction history, deliberately small; the canvas is the record.

import { useEffect, useRef, useState } from 'react';
import { useUI } from './context';

export interface Msg {
  role: 'user' | 'ai' | 'system';
  text: string;
  ops?: string;
}

export function CommandBar({ log, busy, agentName, onSubmit }: { log: Msg[]; busy: string | null; agentName: string; onSubmit: (t: string) => void }) {
  const ui = useUI();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length, open]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const sel = ui.selection.map((id) => ui.ws.objects[id]).filter(Boolean);
  const recent = open ? log : log.slice(-2);

  return (
    <div className="command" onPointerDown={(e) => e.stopPropagation()}>
      {log.length > 0 && (
        <div ref={logRef} className={`log ${open ? '' : 'collapsed'}`} onClick={() => setOpen(!open)} title={open ? 'collapse' : 'show full history'}>
          {recent.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
              {m.ops && <span className="ops">{m.ops}</span>}
            </div>
          ))}
        </div>
      )}
      <form
        className="bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          onSubmit(text.trim());
          setText('');
        }}
      >
        {sel.length > 0 && <span className="this" title="“this” in your request refers to the selection">this = {sel.length === 1 ? sel[0].label : `${sel[0].label} +${sel.length - 1}`}</span>}
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={sel.length ? 'Ask about or change the selection…' : 'Have an idea? Describe it — or press / anytime'}
        />
        {busy ? (
          <span className="status"><span className="spin" />{busy}</span>
        ) : (
          <span className="agent-tag" title="which AI participant is acting">{agentName}</span>
        )}
        <button className="btn ai" disabled={!text.trim() || !!busy} type="submit">↵</button>
      </form>
    </div>
  );
}
