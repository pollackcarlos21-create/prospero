function diffLines(diff: string) {
  let before = 0,
    after = 0,
    inHunk = false;
  return diff
    .split('\n')
    .map((text, i) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        inHunk = true;
        before = Number(hunk[1]);
        after = Number(hunk[2]);
        return { id: i, text, kind: 'hunk', before: '', after: '' };
      }
      if (!inHunk) return { id: i, text, kind: 'header', before: '', after: '' };
      if (text.startsWith('+'))
        return { id: i, text: text.slice(1), kind: 'add', before: '', after: after++ };
      if (text.startsWith('-'))
        return { id: i, text: text.slice(1), kind: 'remove', before: before++, after: '' };
      if (text.startsWith(' '))
        return { id: i, text: text.slice(1), kind: 'context', before: before++, after: after++ };
      return { id: i, text, kind: 'meta', before: '', after: '' };
    })
    .filter((line) => line.kind !== 'header' && (line.kind !== 'meta' || line.text !== ''));
}

export function DiffPreview({ diff }: { diff: string }) {
  return (
    <section className="diff-preview" aria-label="File change diff">
      <div className="diff-heading">Proposed change</div>
      {diffLines(diff).map((line) => (
        <div className={`diff-line ${line.kind}`} key={line.id}>
          <span className="line-number">{line.before}</span>
          <span className="line-number">{line.after}</span>
          <span className="diff-sign">
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
          </span>
          <code>{line.text || ' '}</code>
        </div>
      ))}
    </section>
  );
}
