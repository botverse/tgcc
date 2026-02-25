export interface Node {
    type: string;
    value?: string;
    children?: Node[];
    url?: string;
    alt?: string | null | undefined;
    lang?: string;
    ordered?: boolean;
    start?: number;
}

// TableNode extends Node to include optional header and rows for table handling
export interface TableNode extends Node {
    header?: Node[];
    rows?: Node[];
}

export interface MarkdownOptions {
    tableConversionMode?: string;
}

// --- Helper function for escaping HTML special characters ---
export function escapeHtml(text: unknown): string {
    if (typeof text !== 'string') return '';
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// --- Helper function to get the raw text content of a node ---
export function getNodeText(node: Node): string {
    let text = '';
    if (node.value) {
        text += node.value;
    }
    if (node.children) {
        for (const child of node.children) {
            text += getNodeText(child);
        }
    }
    return text;
}

// --- Helper function to validate if a string is a valid emoji ---
function isValidEmoji(text: string): boolean {
    if (!text) return false;
    // Regex to match a single emoji character
    const emojiRegex = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u;
    return emojiRegex.test(text.trim());
}

// --- Helper function to process spoiler syntax in text ---
export function processSpoilers(text: string): string {
    // Replace ||spoiler|| with <tg-spoiler>spoiler</tg-spoiler>
    // Avoid replacing when the marker is inside a URL
    return text.replace(/\|\|([\s\S]*?)\|\|/g, (match: string, content: string, offset: number, full: string) => {
        // Look behind to see if it's part of a URL
        const before = full.slice(Math.max(0, offset - 100), offset);

        // If preceded by a URL scheme, do not replace
        if (/(?:https?|tg|ftp):\/\/[^\s]*$/.test(before)) {
            return match;
        }

        // Return the spoiler HTML tag
        return `<tg-spoiler>${content}</tg-spoiler>`;
    });
}

// --- Table conversion functions ---

// Convert table to classic pre-formatted code block
function tableToCodeBlock(rows: string[][], hasExplicitHeader: boolean): string {
    const formattedRows: string[] = [];
    
    for (const row of rows) {
        // Escape pipe chars for visual table structure
        const escapedCells = row.map(cell => cell.replace(/\|/g, '\\|'));
        formattedRows.push('| ' + escapedCells.join(' | ') + ' |');
    }

    // Add separator after header if we have 2+ rows
    if (hasExplicitHeader && formattedRows.length >= 2) {
        const headerCols = rows[0].length;
        const separator = `| ${Array(headerCols).fill('---').join(' | ')} |`;
        formattedRows.splice(1, 0, separator);
    }

    const tableText = formattedRows.join('\n');
    return `<pre><code>${escapeHtml(tableText)}</code></pre>\n`;
}

// Convert table to compact view: - **Cell1** — Cell2 — Cell3
function tableToCompactView(rows: string[][]): string {
    const lines: string[] = [];
    
    for (const row of rows) {
        const nonEmptyCells = row.filter(cell => cell.trim() !== '');
        if (nonEmptyCells.length === 0) continue;
        
        const parts: string[] = [];
        for (let i = 0; i < nonEmptyCells.length; i++) {
            const cell = escapeHtml(nonEmptyCells[i]);
            if (i === 0) {
                parts.push(`<b>${cell}</b>`);
            } else {
                parts.push(cell);
            }
        }
        
        lines.push('- ' + parts.join(' \u2014 '));
    }
    
    return lines.join('\n') + '\n\n';
}

// Convert table to detail view with headers: - **Header1: Cell1** followed by nested items
function tableToDetailView(rows: string[][], hasExplicitHeader: boolean): string {
    if (rows.length === 0) return '';
    
    const lines: string[] = [];
    const headers = hasExplicitHeader && rows.length > 1 ? rows[0] : null;
    const dataRows = hasExplicitHeader && rows.length > 1 ? rows.slice(1) : rows;
    
    for (const row of dataRows) {
        const nonEmptyCells: Array<{ value: string; header: string | null }> = [];
        
        for (let i = 0; i < row.length; i++) {
            if (row[i].trim() !== '') {
                nonEmptyCells.push({
                    value: row[i],
                    header: headers ? (headers[i] || null) : null
                });
            }
        }
        
        if (nonEmptyCells.length === 0) continue;
        
        // First cell: - **Header: Value**
        const first = nonEmptyCells[0];
        const firstValue = escapeHtml(first.value);
        if (first.header) {
            const firstHeader = escapeHtml(first.header);
            lines.push(`- <b>${firstHeader}: ${firstValue}</b>`);
        } else {
            lines.push(`- <b>${firstValue}</b>`);
        }
        
        // Subsequent cells: indented with 2 spaces
        for (let i = 1; i < nonEmptyCells.length; i++) {
            const cell = nonEmptyCells[i];
            const cellValue = escapeHtml(cell.value);
            if (cell.header) {
                const cellHeader = escapeHtml(cell.header);
                lines.push(`  - ${cellHeader}: ${cellValue}`);
            } else {
                lines.push(`  - ${cellValue}`);
            }
        }
    }
    
    return lines.join('\n') + '\n\n';
}

// Convert table to detail view without headers: - **Value1** followed by nested items
function tableToDetailViewNoHeaders(rows: string[][]): string {
    if (rows.length === 0) return '';
    
    const lines: string[] = [];
    
    for (const row of rows) {
        const nonEmptyCells = row.filter(cell => cell.trim() !== '');
        if (nonEmptyCells.length === 0) continue;
        
        // First cell: - **Value** (bold, no header)
        const firstValue = escapeHtml(nonEmptyCells[0]);
        lines.push(`- <b>${firstValue}</b>`);
        
        // Subsequent cells: indented with 2 spaces, no header names
        for (let i = 1; i < nonEmptyCells.length; i++) {
            const cellValue = escapeHtml(nonEmptyCells[i]);
            lines.push(`  - ${cellValue}`);
        }
    }
    
    return lines.join('\n') + '\n\n';
}

// --- Main function to convert AST nodes to Telegram HTML ---
export function nodeToHtml(node: Node, context: { listDepth?: number; parent?: Node } = {}, options?: MarkdownOptions): string {
    switch (node.type) {
        case 'root':
            return node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('').trim() : '';

        case 'paragraph':
            return node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') + '\n\n' : '\n\n';

        case 'heading': {
            const headingContent = node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') : '';
            return `<b>${headingContent}</b>\n\n`;
        }

        case 'text': {
            const escapedText = escapeHtml(node.value || '');
            return processSpoilers(escapedText);
        }

        case 'emphasis':
            return `<i>${node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') : ''}</i>`;

        case 'strong':
            return `<b>${node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') : ''}</b>`;

        case 'delete':
            return `<s>${node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') : ''}</s>`;

        case 'inlineCode':
            return `<code>${escapeHtml(node.value || '')}</code>`;

        case 'code': {
            const lang = node.lang ? ` class="language-${escapeHtml(node.lang)}"` : '';
            const code = escapeHtml(node.value || '');
            return `<pre><code${lang}>${code}</code></pre>\n`;
        }

        case 'link': {
            const url = escapeHtml(node.url || '');
            const linkText = node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') : '';
            return `<a href="${url}">${linkText}</a>`;
        }

        case 'image': {
            // Handle tg://emoji links
            if (node.url && node.url.startsWith('tg://emoji')) {
                try {
                    const urlObj = new URL(node.url);
                    const emojiId = urlObj.searchParams.get('id');
                    if (emojiId) {
                        // Validar que el alt es un emoji válido, sino usar fallback
                        let fallbackEmoji = '❓';
                        if (node.alt && isValidEmoji(node.alt)) {
                            fallbackEmoji = node.alt;
                        }
                        return `<tg-emoji emoji-id="${escapeHtml(emojiId)}">${fallbackEmoji}</tg-emoji>`;
                    }
                } catch {
                    // Fallback for invalid tg:// URL
                }
            }
            // Fallback for regular images: show as bold link with alt text
            const imageUrl = escapeHtml(node.url || '');
            const alt = escapeHtml(node.alt || 'image');
            return `<b><a href="${imageUrl}">${alt}</a></b>`;
        }

        case 'blockquote': {
            let isExpandable = false;
            const rawText = getNodeText(node);

            // Check if blockquote should be expandable
            const lineCount = (rawText.match(/\n/g) || []).length + 1;
            if (lineCount > 4 || rawText.length > 320) {
                isExpandable = true;
            }

            // Handle spoiler blockquote syntax (|| at end)
            if (rawText.trim().endsWith('||')) {
                isExpandable = true;
                const removeMarker = (n: Node): boolean => {
                    if (n.type === 'text' && n.value && n.value.endsWith('||')) {
                        n.value = n.value.slice(0, -2);
                        return true;
                    }
                    if (n.children) {
                        for (let i = n.children.length - 1; i >= 0; i--) {
                            if (removeMarker(n.children[i])) return true;
                        }
                    }
                    return false;
                };
                removeMarker(node);
            }

            const content = node.children ? node.children.map((child) => nodeToHtml(child, context, options)).join('') : '';
            const openTag = isExpandable ? '<blockquote expandable>' : '<blockquote>';
            const closeTag = '</blockquote>';
            return `${openTag}${content.trim()}${closeTag}\n\n`;
        }

        case 'list': {
            const currentDepth = context.listDepth || 0;
            const newContext = { ...context, listDepth: currentDepth + 1, parent: node };
            const listItems = node.children ? node.children
                .map((child) => nodeToHtml(child, newContext, options))
                .join('') : '';
            return currentDepth === 0 ? listItems.trimEnd() + '\n\n' : listItems;
        }

        case 'listItem': {
            const depth = context.listDepth || 1;
            const indentation = '&#160;&#160;&#160;&#160;'.repeat(depth - 1);

            let marker;
            if (context.parent?.ordered && context.parent.children) {
                const itemIndex = context.parent.children.indexOf(node);
                marker = `${(context.parent.start || 1) + itemIndex}. `;
            } else {
                marker = '• ';
            }

            let itemContent = '';
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    const child = node.children[i];
                    if (child.type === 'paragraph') {
                        itemContent += child.children ? child.children.map((c) => nodeToHtml(c, context, options)).join('') : '';
                    } else if (child.type === 'list') {
                        const nestedContext = { listDepth: depth, parent: child };
                        const nestedListContent = nodeToHtml(child, nestedContext, options);
                        itemContent += '\n' + nestedListContent.trimEnd();
                    } else {
                        itemContent += nodeToHtml(child, context, options);
                    }
                }
            }

            return `${indentation}${marker}${itemContent}\n`;
        }

        case 'thematicBreak':
            return '------\n\n';

        case 'table': {
            const mode = options?.tableConversionMode || 'codeBlock';
            
            // Helper to extract cells from a row node
            const extractCells = (rowNode: Node): string[] => {
                const cells: string[] = [];
                if (!rowNode) return cells;
                if (rowNode.children) {
                    for (const cellNode of rowNode.children) {
                        let cellText = getNodeText(cellNode) || '';
                        cellText = cellText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
                        cells.push(cellText);
                    }
                }
                return cells;
            };

            // Extract all rows from the table
            const allRows: string[][] = [];
            let hasExplicitHeader = false;

            if ((node as TableNode).header && Array.isArray((node as TableNode).header)) {
                const headerRow = (node as TableNode).header![0];
                const headerCells = extractCells(headerRow);
                if (headerCells.length > 0) {
                    allRows.push(headerCells);
                    hasExplicitHeader = true;
                }

                if ((node as TableNode).rows && Array.isArray((node as TableNode).rows)) {
                    for (const r of (node as TableNode).rows!) {
                        const cells = extractCells(r);
                        if (cells.length > 0) allRows.push(cells);
                    }
                }
            } else if (node.children && node.children.length > 0) {
                for (const rowNode of node.children) {
                    const cells = extractCells(rowNode);
                    if (cells.length > 0) allRows.push(cells);
                }
                // Check if we have a separator line (mdast typically includes it as a row with "---")
                if (allRows.length >= 2) {
                    hasExplicitHeader = true;
                }
            }

            if (allRows.length === 0) return '';

            // Route to appropriate conversion function
            switch (mode) {
                case 'compactView':
                    return tableToCompactView(allRows);
                case 'detailView':
                    return tableToDetailView(allRows, hasExplicitHeader);
                case 'detailViewNoHeaders':
                    return tableToDetailViewNoHeaders(allRows);
                case 'codeBlock':
                default:
                    return tableToCodeBlock(allRows, hasExplicitHeader);
            }
        }


        case 'break':
            return '\n';

        default:
            if (node.children) {
                return node.children.map((child) => nodeToHtml(child, context, options)).join('');
            }
            return '';
    }
}
