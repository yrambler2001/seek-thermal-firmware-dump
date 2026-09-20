/**
 * A four-token inline renderer: `**bold**`, `*emphasis*`, `` `code` `` and
 * plain text.
 *
 * The original page carried its prose as HTML string literals. That copy is
 * carefully worded and is the thing most worth preserving unchanged, so it
 * still lives as single strings here — but as strings a test can assert on,
 * rather than as markup only a browser can read. This turns those strings into
 * the same <strong>/<code> the original rendered.
 */

import type { ReactElement, ReactNode } from 'react';

const TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

/** Splits one line of mini-markup into React nodes. */
export function renderRich(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, index) => {
    const key = `${String(index)}:${part}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

/** The plain-text form of a mini-markup string, for titles and tests. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

export interface RichProps {
  readonly text: string;
  readonly className?: string | undefined;
}

/** One paragraph of mini-markup. */
export function Rich({ text, className }: RichProps): ReactElement {
  return <p className={className}>{renderRich(text)}</p>;
}

export interface RichParagraphsProps {
  readonly paragraphs: readonly string[];
  readonly className?: string | undefined;
}

export function RichParagraphs({ paragraphs, className }: RichParagraphsProps): ReactElement {
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <Rich
          key={`${String(index)}:${paragraph.slice(0, 24)}`}
          text={paragraph}
          {...(className !== undefined ? { className } : {})}
        />
      ))}
    </>
  );
}
