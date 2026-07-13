'use strict';

(() => {
  const sourceElement = document.getElementById('markdown-source');
  const contentElement = document.getElementById('content');
  if (!sourceElement || !contentElement) return;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value, { image = false } = {}) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(raw)) return raw;
    try {
      const parsed = new URL(raw, window.location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
      if (!image && parsed.protocol === 'mailto:') return parsed.toString();
    } catch {}
    return '';
  }

  let markdown = '';
  try {
    markdown = JSON.parse(sourceElement.textContent || '""');
  } catch {
    contentElement.textContent = 'Markdown 内容无法解析。';
    return;
  }
  sourceElement.remove();

  if (!window.marked?.Renderer) {
    contentElement.textContent = markdown;
    return;
  }

  const renderer = new window.marked.Renderer();
  renderer.html = (html) => escapeHtml(html || '');
  renderer.link = (href, title, text) => {
    const url = safeUrl(href);
    if (!url) return text || '';
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${text || ''}</a>`;
  };
  renderer.image = (href, title, text) => {
    const url = safeUrl(href, { image: true });
    if (!url) return '';
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text || '')}" referrerpolicy="no-referrer" loading="lazy"${titleAttribute}>`;
  };

  try {
    contentElement.innerHTML = window.marked.parse(markdown, {
      renderer,
      breaks: true,
      gfm: true,
    });
  } catch {
    contentElement.textContent = markdown;
  }
})();
