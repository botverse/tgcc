import { marked, Renderer } from 'marked';

/**
 * Escape HTML entities for safe use in Telegram HTML parse mode.
 */
function esc(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Custom marked renderer that outputs only Telegram-supported HTML tags:
 * <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">, <blockquote>, <tg-spoiler>
 */
class TelegramRenderer extends Renderer {
  // Block-level

  code(token: { text: string; lang?: string }): string {
    const lang = token.lang || '';
    const langAttr = lang ? ` class="language-${esc(lang)}"` : '';
    return `<pre><code${langAttr}>${esc(token.text)}</code></pre>\n`;
  }

  heading(token: { text: string; depth: number; tokens: any[] }): string {
    const text = this.parser!.parseInline(token.tokens);
    return `\n<b>${text}</b>\n\n`;
  }

  paragraph(token: { text: string; tokens: any[] }): string {
    const text = this.parser!.parseInline(token.tokens);
    return `${text}\n\n`;
  }

  blockquote(token: { text: string; tokens: any[] }): string {
    const body = this.parser!.parse(token.tokens);
    return `<blockquote>${body.trim()}</blockquote>\n`;
  }

  list(token: { ordered: boolean; start: number | ''; items: any[] }): string {
    let counter = token.start || 1;
    const lines = token.items.map((item) => {
      const text = this.parser!.parse(item.tokens).trim();
      if (token.ordered) {
        return `${counter++}. ${text}`;
      }
      return `• ${text}`;
    });
    return lines.join('\n') + '\n\n';
  }

  listitem(token: { text: string; tokens: any[] }): string {
    return this.parser!.parse(token.tokens).trim();
  }

  hr(): string {
    return '\n';
  }

  table(token: { header: any[]; rows: any[][] }): string {
    // Convert table to readable text — Telegram has no table support
    const result: string[] = [];
    for (const row of token.rows) {
      const cells = row.map((cell: any) => this.parser!.parseInline(cell.tokens));
      if (cells.length === 0) continue;
      const first = `<b>${cells[0]}</b>`;
      const rest = cells.slice(1);
      result.push(rest.length > 0 ? `${first} — ${rest.join(' — ')}` : first);
    }
    return result.join('\n') + '\n\n';
  }

  tablerow(): string { return ''; }
  tablecell(): string { return ''; }

  // Inline

  strong(token: { text: string; tokens: any[] }): string {
    const text = this.parser!.parseInline(token.tokens);
    return `<b>${text}</b>`;
  }

  em(token: { text: string; tokens: any[] }): string {
    const text = this.parser!.parseInline(token.tokens);
    return `<i>${text}</i>`;
  }

  del(token: { text: string; tokens: any[] }): string {
    const text = this.parser!.parseInline(token.tokens);
    return `<s>${text}</s>`;
  }

  codespan(token: { text: string }): string {
    return `<code>${esc(token.text)}</code>`;
  }

  link(token: { href: string; text: string; tokens: any[] }): string {
    const text = this.parser!.parseInline(token.tokens);
    return `<a href="${esc(token.href)}">${text}</a>`;
  }

  image(token: { href: string; text: string; title: string | null }): string {
    return token.text || '[image]';
  }

  text(token: { text: string } | string): string {
    const t = typeof token === 'string' ? token : token.text;
    return esc(t);
  }

  br(): string {
    return '\n';
  }

  html(token: { text: string }): string {
    // Telegram doesn't support arbitrary HTML — escape it
    return esc(token.text);
  }

  space(): string {
    return '';
  }
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Uses `marked` with a custom renderer — no regex heuristics.
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return '';

  const renderer = new TelegramRenderer();

  const result = marked(text, {
    gfm: true,
    breaks: false,
    renderer,
  }) as string;

  // Clean up excessive newlines
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
