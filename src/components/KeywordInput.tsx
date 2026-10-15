import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cleanKeyword, KEYWORD_LIMITS, keywordKey } from '../../shared/submission';

/** Keys that finish a keyword besides Enter (typed or pasted). */
const SEPARATORS = /[,，、\n]/;

/**
 * Free-form keyword input: type anything ("适合约会"), press Enter (or a
 * comma, or leave the field) and it becomes a chip that can be removed on its
 * own. While an input method is composing (pinyin), Enter only confirms the
 * characters and never adds a keyword. Repeats of a keyword are ignored with a
 * short note; count and length are limited (KEYWORD_LIMITS).
 */
export function KeywordInput({
  value,
  onChange,
  label,
  hint,
}: {
  value: string[];
  onChange: (keywords: string[]) => void;
  label: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const full = value.length >= KEYWORD_LIMITS.count;

  /** Adds the given texts as keywords; returns the keywords after adding. */
  const add = (texts: string[]) => {
    let next = value;
    let message = '';
    for (const text of texts.map(cleanKeyword).filter(Boolean)) {
      if (next.some((k) => keywordKey(k) === keywordKey(text))) {
        message = `已经添加过「${text}」`;
      } else if (next.length >= KEYWORD_LIMITS.count) {
        message = `最多 ${KEYWORD_LIMITS.count} 个关键词`;
      } else {
        next = [...next, text];
      }
    }
    if (next !== value) onChange(next);
    setNote(message);
    return next;
  };

  /** Turns the text being typed into a keyword (Enter, separators, leaving the field). */
  const commit = () => {
    if (!draft.trim()) return;
    add(draft.split(SEPARATORS));
    setDraft('');
  };

  const remove = (i: number) => {
    const removed = value[i];
    onChange(value.filter((_, n) => n !== i));
    setNote(removed ? `已删除「${removed}」` : '');
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An input method uses Enter to confirm its characters (isComposing, and
    // keyCode 229 in browsers that finish composing before keydown).
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      remove(value.length - 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!SEPARATORS.test(text)) return;
    e.preventDefault();
    const parts = `${draft}${text}`.split(SEPARATORS);
    const last = parts.pop() ?? '';
    add(parts);
    setDraft(last.slice(0, KEYWORD_LIMITS.length));
  };

  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-input`} className="block font-black">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-2 border-ink bg-white p-1.5 focus-within:outline-3 focus-within:outline-chili-600">
        {value.length > 0 && (
          <ul aria-label="已添加的关键词" className="contents">
            {value.map((keyword, i) => (
              <li
                key={keywordKey(keyword)}
                className="inline-flex max-w-full items-center gap-1 border-2 border-ink bg-gold-100 py-0.5 pr-0.5 pl-2 text-sm font-bold"
              >
                <span className="min-w-0 break-all">{keyword}</span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`删除关键词「${keyword}」`}
                  className="inline-flex size-7 shrink-0 items-center justify-center text-base leading-none hover:bg-chili-100 hover:text-chili-700"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={input}
          id={`${id}-input`}
          type="text"
          enterKeyHint="done"
          autoComplete="off"
          value={draft}
          maxLength={KEYWORD_LIMITS.length}
          disabled={full && draft === ''}
          placeholder={
            full
              ? `已达到 ${KEYWORD_LIMITS.count} 个上限`
              : value.length
                ? '继续添加…'
                : '输入后按回车'
          }
          aria-describedby={[hint && `${id}-hint`, `${id}-note`].filter(Boolean).join(' ')}
          onChange={(e) => {
            const text = e.target.value;
            if (!composing.current && SEPARATORS.test(text)) {
              const parts = text.split(SEPARATORS);
              const last = parts.pop() ?? '';
              add(parts);
              setDraft(last);
            } else {
              setDraft(text);
            }
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={commit}
          className="min-h-9 min-w-32 flex-1 bg-transparent px-1.5 text-base outline-none placeholder:text-muted/70"
        />
      </div>
      <p id={`${id}-note`} role="status" className="min-h-5 text-xs text-muted">
        {note || `${value.length}/${KEYWORD_LIMITS.count}，每个最多 ${KEYWORD_LIMITS.length} 字`}
      </p>
    </div>
  );
}
