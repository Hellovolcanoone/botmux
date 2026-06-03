export type PiLineEditorEvent =
  | { type: 'submit'; content: string };

export class PiLineEditor {
  private buffer = '';
  private pasteBuffer = '';
  private inBracketedPaste = false;
  private pendingEscape = '';

  feed(data: string): PiLineEditorEvent[] {
    const events: PiLineEditorEvent[] = [];
    let input = data;
    if (this.pendingEscape) {
      input = this.pendingEscape + input;
      this.pendingEscape = '';
    }

    let i = 0;
    while (i < input.length) {
      if (this.inBracketedPaste) {
        const end = input.indexOf('\x1b[201~', i);
        if (end === -1) {
          this.pasteBuffer += input.slice(i);
          break;
        }
        this.buffer += this.pasteBuffer + input.slice(i, end);
        this.pasteBuffer = '';
        this.inBracketedPaste = false;
        i = end + '\x1b[201~'.length;
        continue;
      }

      if (input.startsWith('\x1b[200~', i)) {
        this.inBracketedPaste = true;
        this.pasteBuffer = '';
        i += '\x1b[200~'.length;
        continue;
      }

      const ch = input[i]!;
      if (ch === '\r' || ch === '\n') {
        const content = this.buffer.trim();
        if (content) events.push({ type: 'submit', content });
        this.buffer = '';
        if (ch === '\r' && input[i + 1] === '\n') i += 2;
        else i += 1;
        continue;
      }

      if (ch === '\x7f' || ch === '\b') {
        this.buffer = this.buffer.slice(0, -1);
        i += 1;
        continue;
      }

      if (ch === '\x1b') {
        const consumed = this.consumeEscape(input, i);
        if (consumed === 0) {
          this.pendingEscape = input.slice(i);
          break;
        }
        i += consumed;
        continue;
      }

      if (ch === '\x03' || ch === '\t') {
        i += 1;
        continue;
      }

      if (ch >= ' ') {
        this.buffer += ch;
      }
      i += 1;
    }
    return events;
  }

  private consumeEscape(data: string, offset: number): number {
    const remaining = data.length - offset;
    const next = data[offset + 1];
    if (next === undefined) return 0;
    if (next === '[') {
      let i = offset + 2;
      while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++;
      if (i >= data.length) return 0;
      return i - offset + 1;
    }
    return Math.min(2, remaining);
  }
}
