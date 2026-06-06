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
  tableElements.forEach((table, index) => {
    // Convert to markdown
    const markdown = htmlTableToMarkdown(table);
    if (markdown) {
      markdownParts.push(`\n### Table ${index + 1}\n\n${markdown}\n`);
    }
    
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
  
  // Get plain text fallback
  const plainText = document.body.textContent?.replace(/\s+/g, ' ').trim() || '';
  
  // Combine text with markdown tables
  const markdownText = markdownParts.length > 0 
    ? plainText + '\n' + markdownParts.join('\n')
    : undefined;
  
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
  if (!source) return null;
  
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
  
  // Check encoding in the Content-Type or Content-Transfer-Encoding header
  const beforeHtml = source.substring(0, match.index || 0);
  
  // Handle quoted-printable encoding
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(beforeHtml)) {
    html = decodeQuotedPrintable(html);
  }
  
  // Handle base64 encoding
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
  return text
    // Remove soft line breaks (= at end of line)
    .replace(/=\r?\n/g, '')
    // Decode =XX hex sequences
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => 
      String.fromCharCode(parseInt(hex, 16))
    );
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
