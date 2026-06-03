import { describe, expect, it } from 'vitest';
import { PiLineEditor } from '../src/pi-line-editor.js';

function submitTexts(editor: PiLineEditor, input: string): string[] {
  return editor.feed(input).map(e => e.content);
}

describe('PiLineEditor', () => {
  it('submits when CR appears inside a combined chunk', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, 'hello\r')).toEqual(['hello']);
  });

  it('handles multiple lines in one chunk', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, 'one\ntwo\r')).toEqual(['one', 'two']);
  });

  it('applies backspace before submit', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, 'helo\b lo\r')).toEqual(['hel lo']);
  });

  it('preserves bracketed paste text and submits after the paste', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, '\x1b[200~hello\nworld\x1b[201~\r')).toEqual(['hello\nworld']);
  });

  it('ignores arrow/control escape sequences without dropping surrounding text', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, 'he\x1b[Dllo\r')).toEqual(['hello']);
  });

  it('keeps split escape sequences pending without leaking suffix characters', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, 'he\x1b[')).toEqual([]);
    expect(submitTexts(editor, 'Dllo\r')).toEqual(['hello']);
  });

  it('does not swallow normal text after an incomplete escape is resolved', () => {
    const editor = new PiLineEditor();
    expect(submitTexts(editor, 'a\x1b')).toEqual([]);
    expect(submitTexts(editor, 'b\r')).toEqual(['a']);
  });
});
