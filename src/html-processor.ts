import { JSDOM } from 'jsdom';
import sanitizeHtml from 'sanitize-html';

export interface ProcessedEmailContent {
  plainText: string;
  markdownText?: string;
  tables?: Array<{
    headers: string[];
    rows: string[][];
  }>;
}

/**
 * Convert HTML table to Markdown table
 */
export function htmlTableToMarkdown(tableElement: Element): string {
  const rows: string[][] = [];
  
  // Extract headers from thead or first row with th elements
  const headerCells = Array.from(tableElement.querySelectorAll('thead th, tr:first-child th'));
  const headers = headerCells.map(th => (th.textContent?.trim() || '').replace(/\|/g, '\\|'));
  
  if (headers.length > 0) {
    rows.push(headers);
  }
  
  // Extract data rows from tbody or all tr elements with td
  const dataRows = tableElement.querySelectorAll('tbody tr, tr');
  dataRows.forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('td'));
    if (cells.length > 0) {
      const rowData = cells.map(td => (td.textContent?.trim() || '').replace(/\|/g, '\\|'));
      rows.push(rowData);
    }
  });
  
  if (rows.length === 0) return '';
  
  // Build Markdown table
  const markdown: string[] = [];
  
  // Add header row if exists
  if (headers.length > 0) {
    const headerRow = rows[0];
    markdown.push('| ' + headerRow.join(' | ') + ' |');
    markdown.push('| ' + headerRow.map(() => '---').join(' | ') + ' |');
    
    // Add data rows
    for (let i = 1; i < rows.length; i++) {
      // Pad row to match header length
      const row = rows[i];
      while (row.length < headerRow.length) row.push('');
      markdown.push('| ' + row.slice(0, headerRow.length).join(' | ') + ' |');
    }
  } else {
    // No headers, treat first row as header for markdown format
    if (rows.length > 0) {
      const firstRow = rows[0];
      markdown.push('| ' + firstRow.join(' | ') + ' |');
      markdown.push('| ' + firstRow.map(() => '---').join(' | ') + ' |');
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        while (row.length < firstRow.length) row.push('');
        markdown.push('| ' + row.slice(0, firstRow.length).join(' | ') + ' |');
      }
    }
  }
  
  return markdown.join('\n');
}

/**
 * Process HTML email content and extract tables
 */
export function processHtmlEmail(htmlContent: string): ProcessedEmailContent {
  console.log('[html-processor] processHtmlEmail: input length =', htmlContent.length, 'chars');
  
  // Sanitize HTML first (allow table elements)
  const clean = sanitizeHtml(htmlContent, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'table', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption',
      'br', 'p', 'div', 'span', 'strong', 'em', 'b', 'i', 'u'
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      'table': ['border', 'cellpadding', 'cellspacing', 'width'],
      'td': ['colspan', 'rowspan', 'align'],
      'th': ['colspan', 'rowspan', 'align'],
    }
  });
  
  // Parse with jsdom
  const dom = new JSDOM(clean);
  const document = dom.window.document;
  
  // Extract tables and convert to markdown
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const markdownParts: string[] = [];
  
  // Find all tables
  const tableElements = document.querySelectorAll('table');
  console.log('[html-processor] Found', tableElements.length, 'table elements');
  
  // Replace each table with a placeholder in the HTML
  const tablePlaceholders: Map<string, string> = new Map();
  tableElements.forEach((table, index) => {
    const placeholder = `__TABLE_${index}__`;
    const markdown = htmlTableToMarkdown(table);
    console.log(`[html-processor] Table ${index + 1} markdown length:`, markdown?.length || 0);
    if (markdown) {
      tablePlaceholders.set(placeholder, `\n\n### Table ${index + 1}\n\n${markdown}\n\n`);
      console.log(`[html-processor] Table ${index + 1} markdown preview:`, markdown.substring(0, 150));
    }
    
    // Replace table with placeholder text node
    const placeholderNode = document.createTextNode(placeholder);
    table.replaceWith(placeholderNode);
    
    // Extract structured data
    const headerCells = Array.from(table.querySelectorAll('thead th, tr:first-child th'));
    const headers = headerCells.map(th => th.textContent?.trim() || '');
    
    const dataRows: string[][] = [];
    const trs = table.querySelectorAll('tbody tr, tr');
    trs.forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length > 0) {
        dataRows.push(cells.map(td => td.textContent?.trim() || ''));
      }
    });
    
    if (dataRows.length > 0) {
      tables.push({ headers, rows: dataRows });
    }
  });
  
  // Get text content with placeholders
  let combinedText = document.body.textContent?.trim() || '';
  
  // Replace placeholders with markdown tables
  tablePlaceholders.forEach((markdown, placeholder) => {
    combinedText = combinedText.replace(placeholder, markdown);
  });
  
  // Clean up excessive whitespace
  combinedText = combinedText.replace(/\n{3,}/g, '\n\n').trim();
  
  // Get plain text (for when no tables found)
  const plainText = document.body.textContent?.replace(/\s+/g, ' ').trim() || '';
  
  // Return combined text with tables in original positions, or undefined if no tables
  const markdownText = tables.length > 0 ? combinedText : undefined;
  
  console.log('[html-processor] Result: plainText length =', plainText.length, ', markdownText length =', markdownText?.length || 0, ', tables =', tables.length);
  
  if (markdownText && tables.length > 0) {
    console.log('[html-processor] Combined text preview:', combinedText.substring(0, 200));
  }
  
  return {
    plainText,
    markdownText,
    tables: tables.length > 0 ? tables : undefined,
  };
}

/**
 * Extract HTML body from raw email MIME source
 * Handles multipart MIME and various encodings
 */
export function extractHtmlFromEmailSource(source: string): string | null {
  if (!source) {
    console.log('[html-processor] extractHtmlFromEmailSource: source is empty');
    return null;
  }
  
  console.log('[html-processor] extractHtmlFromEmailSource: source length =', source.length, 'chars, has <table>:', source.includes('<table'));
  
  // First decode the entire source if it's quoted-printable
  // This handles the case where the MIME content itself is encoded
  if (source.includes('Content-Transfer-Encoding: quoted-printable')) {
    console.log('[html-processor] Source contains quoted-printable encoding, decoding entire source first');
    source = decodeQuotedPrintable(source);
  }
  
  // Check if this is already HTML (not MIME wrapped)
  if (source.includes('<html') || source.includes('<HTML')) {
    return source;
  }
  
  // Look for Content-Type: text/html section
  const htmlPartRegex = /Content-Type:\s*text\/html[^\n]*\n(?:Content-[^\n]+\n)*\n([\s\S]*?)(?=\n--[\w-]+(?:--)?(?:\n|$)|\nContent-Type:|$)/i;
  const match = source.match(htmlPartRegex);
  
  if (!match || !match[1]) {
    // Fallback: check if source contains HTML tags
    if (source.includes('<table') || source.includes('<TABLE')) {
      return source;
    }
    return null;
  }
  
  let html = match[1].trim();
  
  // Handle base64 encoding (check for this in the header before the HTML part)
  const beforeHtml = source.substring(0, match.index || 0);
  if (/Content-Transfer-Encoding:\s*base64/i.test(beforeHtml)) {
    try {
      html = Buffer.from(html.replace(/\s/g, ''), 'base64').toString('utf-8');
    } catch (e) {
      console.error('[html-processor] Failed to decode base64:', e);
    }
  }
  
  return html;
}

/**
 * Decode quoted-printable encoded text
 */
function decodeQuotedPrintable(text: string): string {
  // Remove soft line breaks (= at end of line)
  text = text.replace(/=\r?\n/g, '');
  
  // Collect all =XX sequences and their positions
  const bytes: number[] = [];
  let result = '';
  let lastIndex = 0;
  
  const hexRegex = /=([0-9A-F]{2})/gi;
  let match: RegExpExecArray | null;
  
  while ((match = hexRegex.exec(text)) !== null) {
    // Add any text before this hex sequence
    if (match.index > lastIndex) {
      result += text.substring(lastIndex, match.index);
    }
    
    // Collect the byte
    bytes.push(parseInt(match[1], 16));
    lastIndex = match.index + match[0].length;
    
    // Check if next character is also a hex sequence
    const nextMatch = /^=([0-9A-F]{2})/i.exec(text.substring(lastIndex));
    if (!nextMatch) {
      // No more consecutive hex sequences, decode the accumulated bytes as UTF-8
      if (bytes.length > 0) {
        try {
          const buffer = Buffer.from(bytes);
          result += buffer.toString('utf-8');
        } catch (e) {
          // Fallback to simple char conversion
          result += String.fromCharCode(...bytes);
        }
        bytes.length = 0;
      }
    }
  }
  
  // Add any remaining text
  if (lastIndex < text.length) {
    result += text.substring(lastIndex);
  }
  
  // Decode any remaining bytes
  if (bytes.length > 0) {
    try {
      const buffer = Buffer.from(bytes);
      result += buffer.toString('utf-8');
    } catch (e) {
      result += String.fromCharCode(...bytes);
    }
  }
  
  return result;
}

/**
 * Simple HTML to plain text with basic formatting
 * Preserves some structure for better readability
 */
export function htmlToPlainText(html: string): string {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  
  // Remove script and style elements
  document.querySelectorAll('script, style').forEach(el => el.remove());
  
  // Add newlines for block elements
  document.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6').forEach(el => {
    const text = el.textContent || '';
    if (el.tagName === 'BR') {
      el.textContent = '\n';
    } else if (text.trim()) {
      el.textContent = text + '\n\n';
    }
  });
  
  // Get text content
  const text = document.body.textContent || '';
  
  // Clean up excessive whitespace
  return text
    .replace(/[ \t]+/g, ' ')  // Multiple spaces/tabs to single space
    .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive newlines
    .trim();
}
