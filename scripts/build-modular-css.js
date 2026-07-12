#!/usr/bin/env node
/**
 * Build modular Codex-design CSS from style-main.css reference.
 * Run once: node scripts/build-modular-css.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = '/tmp/style-main.css';
const OUT = path.join(ROOT, 'public', 'css');

const TOKENS = `/* 00-tokens.css — Codex design tokens (graphite-on-paper) */
:root {
  /* Colors */
  --color-sidebar-mist: #f9f9f9;
  --color-pure-white: #ffffff;
  --color-graphite-ink: #0d0d0d;
  --color-mid-ash: #5d5d5d;
  --color-hollow: #8f8f8f;
  --color-hairline: #0000001a;
  --color-hover-veil: #0000000d;
  --color-ink-press: #000000;
  --color-deep-charcoal: #00000080;
  --color-edge-gray: #e6e6e6;

  /* Typography */
  --font-apple-system-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Hiragino Sans', 'Noto Sans CJK SC', sans-serif;
  --font-ui: var(--font-apple-system-body);
  --font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'Courier New', 'Noto Sans Mono CJK SC', monospace;
  --text-caption: 14px;
  --leading-caption: 1.43;
  --text-body: 16px;
  --leading-body: 1.5;
  --text-heading: 24px;
  --leading-heading: 1.33;
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;

  /* Spacing */
  --spacing-6: 6px;
  --spacing-8: 8px;
  --spacing-10: 10px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-20: 20px;
  --section-gap: 24px;
  --card-padding: 16px;
  --element-gap: 6px;
  --space-2xs: 2px;
  --space-xs: 4px;
  --space-sm: 6px;
  --space-md: 8px;
  --space-lg: 12px;
  --space-xl: 16px;
  --space-2xl: 20px;
  --space-3xl: 24px;

  /* Radii */
  --radius-nav: 10px;
  --radius-cards: 10px;
  --radius-links: 16px;
  --radius-badges: 0px;
  --radius-buttons: 10px;
  --radius-pill: 9999px;

  /* Layout */
  --page-max-width: 1200px;
  --sidebar-width: 270px;
  --git-panel-width: 340px;
  --header-height: 52px;
  --chat-max-width: 768px;
  --input-max-height: 200px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);

  /* Surfaces */
  --surface-sidebar-canvas: var(--color-sidebar-mist);
  --surface-conversation-canvas: var(--color-pure-white);
  --surface-elevated-panel: var(--color-pure-white);

  /* Semantic aliases (layout mechanics from main branch) */
  --bg-primary: var(--color-pure-white);
  --bg-secondary: var(--color-sidebar-mist);
  --bg-tertiary: #f0f0f0;
  --bg-bubble-user: var(--color-pure-white);
  --bg-bubble-assistant: var(--color-pure-white);
  --text-primary: var(--color-graphite-ink);
  --text-secondary: var(--color-mid-ash);
  --text-muted: var(--color-hollow);
  --border-color: var(--color-hairline);
  --accent: var(--color-graphite-ink);
  --accent-hover: var(--color-ink-press);
  --accent-light: var(--color-hover-veil);
  --success: var(--color-mid-ash);
  --danger: var(--color-graphite-ink);
  --info: var(--color-mid-ash);
  --scrollbar-thumb: rgba(0, 0, 0, 0.15);
  --scrollbar-track: transparent;
  --line: var(--color-hairline);
  --blue: var(--color-graphite-ink);
  --yellow: var(--color-hover-veil);
  --blue-strong: var(--color-ink-press);
  --surface: var(--color-pure-white);
  --surface-strong: var(--color-pure-white);
  --surface-muted: rgba(255, 255, 255, 0.92);
  --surface-elevated: var(--color-pure-white);
  --surface-overlay: var(--color-deep-charcoal);
  --surface-overlay-strong: rgba(0, 0, 0, 0.6);
  --surface-inverse: var(--color-ink-press);
  --surface-inverse-text: var(--color-pure-white);
  --page-background: var(--color-pure-white);
  --login-background: var(--color-sidebar-mist);
  --panel-background: var(--color-pure-white);
  --panel-border: var(--color-hairline);
  --panel-shadow: none;
  --panel-shadow-soft: none;
  --topbar-background: var(--color-pure-white);
  --topbar-border: var(--color-hairline);
  --sidebar-background: var(--color-sidebar-mist);
  --sidebar-border: var(--color-hairline);
  --sidebar-item-hover: var(--color-hover-veil);
  --sidebar-item-active: var(--color-hover-veil);
  --sidebar-item-badge-active: var(--color-hover-veil);
  --sidebar-active-pill: var(--color-hover-veil);
  --chat-card-radius: var(--radius-cards);
  --chat-card-border-radius: var(--radius-cards);
  --chat-menu-shadow: none;
  --modal-overlay-background: var(--color-deep-charcoal);
  --settings-overlay-background: var(--color-deep-charcoal);
  --force-overlay-background: rgba(0, 0, 0, 0.6);
  --mobile-sidebar-overlay-background: var(--color-deep-charcoal);
  --toast-success-text: var(--color-pure-white);
  --chat-header-background: var(--color-pure-white);
  --chat-header-border: var(--color-hairline);
  --chat-background: var(--color-pure-white);
  --message-user-background: var(--color-pure-white);
  --message-user-text: var(--color-graphite-ink);
  --message-user-shadow: none;
  --message-user-inline-code-bg: var(--color-sidebar-mist);
  --message-user-inline-code-border: var(--color-hairline);
  --message-user-inline-code-text: var(--color-graphite-ink);
  --message-user-attachment-bg: var(--color-sidebar-mist);
  --message-user-attachment-border: var(--color-hairline);
  --message-user-attachment-text: var(--color-mid-ash);
  --message-assistant-background: var(--color-pure-white);
  --message-assistant-text: var(--text-primary);
  --message-assistant-shadow: none;
  --message-system-background: var(--color-sidebar-mist);
  --message-system-border: var(--color-hairline);
  --tool-card-background: var(--color-pure-white);
  --tool-card-hover: var(--color-hover-veil);
  --tool-card-running-bg: var(--color-hover-veil);
  --tool-card-error-bg: var(--color-sidebar-mist);
  --input-background: var(--color-pure-white);
  --input-shell-background: var(--color-pure-white);
  --input-border: var(--color-hairline);
  --input-focus-shadow: none;
  --input-drag-shadow: none;
  --btn-primary-bg: var(--color-graphite-ink);
  --btn-primary-hover: var(--color-ink-press);
  --btn-secondary-bg: var(--color-pure-white);
  --btn-secondary-hover: var(--color-hover-veil);
  --btn-danger-bg: var(--color-graphite-ink);
  --btn-danger-hover: var(--color-ink-press);
  --compact-btn-hover-bg: var(--color-hover-veil);
  --compact-btn-hover-color: var(--text-primary);
  --segmented-control-group-border: 1px solid var(--color-hairline);
  --segmented-control-group-radius: var(--radius-nav);
  --segmented-control-group-background: var(--color-pure-white);
  --segmented-control-group-padding: 2px;
  --segmented-control-group-gap: 2px;
  --segmented-control-item-background: transparent;
  --segmented-control-item-color: var(--text-secondary);
  --segmented-control-item-hover-background: var(--color-hover-veil);
  --segmented-control-item-hover-color: var(--text-primary);
  --segmented-control-item-active-background: var(--color-hover-veil);
  --segmented-control-item-alt-active-background: var(--color-hover-veil);
  --segmented-control-item-active-color: var(--text-primary);
  --segmented-control-item-radius: var(--radius-nav);
  --segmented-control-item-shadow: none;
  --segmented-control-item-active-shadow: none;
  --compact-control-border: 1px solid var(--color-hairline);
  --compact-control-radius: var(--radius-nav);
  --compact-control-background: transparent;
  --compact-control-color: var(--text-muted);
  --compact-control-shadow: none;
  --compact-control-hover-background: var(--color-hover-veil);
  --compact-control-hover-color: var(--text-primary);
  --compact-control-hover-shadow: none;
  --compact-control-hover-shift: 0;
  --compact-control-active-background: var(--color-hover-veil);
  --compact-control-active-color: var(--text-primary);
  --compact-control-active-border: var(--color-hairline);
  --compact-control-active-shadow: none;
  --compact-control-active-shift: 0;
  --toolbar-button-background: transparent;
  --toolbar-button-color: var(--text-secondary);
  --toolbar-button-border: var(--color-hairline);
  --toolbar-button-radius: var(--radius-nav);
  --toolbar-button-shadow: none;
  --toolbar-button-hover-background: var(--color-hover-veil);
  --toolbar-button-hover-color: var(--text-primary);
  --toolbar-button-primary-background: var(--color-hover-veil);
  --toolbar-button-primary-border: var(--color-hairline);
  --toolbar-button-primary-color: var(--text-primary);
  --toolbar-button-primary-hover-background: var(--color-hover-veil);
  --toolbar-button-primary-hover-border: var(--color-edge-gray);
  --toolbar-button-primary-hover-color: var(--text-primary);
  --action-button-background: transparent;
  --action-button-color: var(--text-secondary);
  --action-button-border: var(--color-hairline);
  --action-button-radius: var(--radius-nav);
  --action-button-shadow: none;
  --action-button-hover-background: var(--color-hover-veil);
  --action-button-hover-color: var(--text-primary);
  --action-button-hover-shadow: none;
  --action-button-hover-shift: 0;
  --action-button-primary-background: var(--color-hover-veil);
  --action-button-primary-color: var(--text-primary);
  --action-button-primary-hover-background: var(--color-hover-veil);
  --action-button-primary-hover-color: var(--text-primary);
  --button-surface: transparent;
  --button-surface-hover: var(--color-hover-veil);
  --button-secondary-surface: transparent;
  --button-secondary-hover: var(--color-hover-veil);
  --button-primary-text: var(--text-primary);
  --button-secondary-text: var(--text-primary);
  --button-border: var(--color-hairline);
  --button-shadow-soft: none;
  --button-shadow-strong: none;
  --button-shadow-pressed: none;
  --button-radius: var(--radius-buttons);
  --btn-icon-size: 32px;
  --btn-sm-min-h: 28px;
  --btn-md-min-h: 32px;
  --btn-lg-min-h: 40px;
  --btn-sm-font: 12px;
  --btn-md-font: 13px;
  --btn-lg-font: 14px;
  --btn-sm-pad-x: 10px;
  --btn-md-pad-x: 14px;
  --btn-lg-pad-x: 16px;
  --btn-sm-pad-y: 4px;
  --btn-md-pad-y: 6px;
  --btn-lg-pad-y: 8px;
  --btn-letter-spacing: normal;
  --danger-soft: var(--color-hover-veil);
  --danger-soft-strong: var(--color-sidebar-mist);
  --accent-soft-strong: var(--color-hover-veil);
  --inline-note-border: var(--color-hairline);
  --inline-note-background: var(--color-sidebar-mist);
  --inline-note-code-bg: var(--color-hover-veil);
  --floating-card-background: var(--color-pure-white);
  --floating-card-shadow: none;
  --tree-surface: var(--color-pure-white);
  --tree-surface-subtle: var(--color-sidebar-mist);
  --tree-hover-bg: var(--color-hover-veil);
  --tree-active-bg: var(--color-hover-veil);
  --tree-border: var(--color-hairline);
  --tree-strong-border: var(--color-hairline);
  --tree-guide-color: var(--color-hairline);
  --tree-shadow-soft: none;
  --tree-shadow-strong: none;
  --list-row-hover-bg: var(--color-hover-veil);
  --list-row-active-bg: var(--color-hover-veil);
  --list-row-border: var(--color-hairline);
  --list-row-hover-border: var(--color-hairline);
  --list-row-active-border: var(--color-edge-gray);
  --pill-surface: var(--color-sidebar-mist);
  --pill-border: var(--color-hairline);
  --pill-text: var(--text-secondary);
  --git-tree-folder-bg: var(--color-sidebar-mist);
  --git-tree-file-bg: var(--color-pure-white);
  --git-tree-guide: var(--color-hairline);
  --git-tree-count-bg: var(--color-hover-veil);
  --git-tree-header-hover-bg: var(--color-hover-veil);
  --git-tree-row-shadow: none;
  --git-tree-guide-active: var(--color-edge-gray);
  --git-tree-meta-bg: var(--color-sidebar-mist);
  --git-tree-action-bg: var(--color-pure-white);
  --git-tree-action-hover-bg: var(--color-hover-veil);
  --git-tree-action-hover-text: var(--text-primary);
  --git-tree-stage-bg: var(--color-hover-veil);
  --git-tree-stage-hover-bg: var(--color-edge-gray);
  --git-tree-indent-step: 18px;
  --git-tree-indent-step-mobile: 14px;
  --chat-title-edit-bg: var(--color-pure-white);
  --shadow-strong: none;
  --accent-fallback: var(--color-graphite-ink);
  --success-strong: var(--color-mid-ash);
  --code-header-bg: var(--color-sidebar-mist);
  --code-header-text: var(--color-mid-ash);
  --code-action-border: var(--color-hairline);
  --code-action-hover-bg: var(--color-hover-veil);
  --code-action-hover-text: var(--color-graphite-ink);
  --panel-inverse-background: var(--color-ink-press);
  --panel-inverse-text: var(--color-pure-white);
  --loading-overlay-scrim: var(--color-deep-charcoal);
  --loading-card-bg: var(--color-pure-white);
  --loading-card-border: var(--color-hairline);
  --loading-card-shadow: none;
  --loading-badge-bg: var(--color-hover-veil);
  --loading-badge-text: var(--text-secondary);
  --loading-bar-bg: var(--color-edge-gray);
  --loading-bar-fill: var(--color-graphite-ink);
  --select-caret-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238f8f8f'/%3E%3C/svg%3E");
  --mobile-topbar-select-background: transparent;
  --mobile-topbar-select-border: 1px solid var(--color-hairline);
  --mobile-topbar-select-radius: var(--radius-nav);
  --mobile-topbar-select-shadow: none;
  --mobile-topbar-select-color: var(--text-primary);
  --mobile-topbar-select-hover-background: var(--color-hover-veil);
}
`;

const SIDEBAR_FIRST = `
/* Sidebar-first shell */
.app-workspace {
  height: 100%;
}

.sidebar {
  height: 100%;
}

.sidebar-top-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  min-height: var(--header-height);
  padding: 0 var(--spacing-12);
  border-bottom: 1px solid var(--color-hairline);
  flex-shrink: 0;
}

.sidebar-top-brand strong {
  font-size: var(--text-caption);
  font-weight: var(--font-weight-semibold);
  color: var(--color-graphite-ink);
}

.sidebar-top-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-6);
}

.sidebar-cost {
  font-size: 12px;
  color: var(--color-hollow);
}

.sidebar-footer {
  flex-shrink: 0;
  padding: var(--spacing-12);
  border-top: 1px solid var(--color-hairline);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-10);
  text-align: left;
}

.sidebar-footer-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-6);
}

.sidebar-footer-label {
  font-size: 12px;
  font-weight: var(--font-weight-medium);
  color: var(--color-hollow);
  padding: 0 var(--spacing-6);
}

.sidebar-cwd {
  font-size: 12px;
  color: var(--color-hollow);
  padding: var(--spacing-6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-header {
  padding: var(--spacing-12);
  border-bottom: none;
}

.session-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-hollow);
  pointer-events: none;
}

.session-search-input {
  padding: var(--spacing-8) 28px var(--spacing-8) 32px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-nav);
  background: transparent;
  font-size: var(--text-caption);
}

.session-search-input:focus {
  border-color: var(--color-edge-gray);
  box-shadow: none;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-6) var(--spacing-8);
}

/* Centered conversation column */
.chat-stage-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: var(--chat-max-width);
  margin: 0 auto;
}

.messages {
  padding-left: var(--spacing-16);
  padding-right: var(--spacing-16);
}

.input-area {
  background: var(--color-pure-white);
  border-top: 1px solid var(--color-hairline);
}
`;

const THEMES = `/* 07-themes.css — minimal localhost variant */
html[data-theme="localhost"] {
  color-scheme: light;
}

html[data-theme="localhost"] body {
  background: var(--color-pure-white);
}

html[data-theme="localhost"] .sidebar-footer-label,
html[data-theme="localhost"] .chat-agent-context,
html[data-theme="localhost"] .welcome-stats,
html[data-theme="localhost"] .welcome-panel {
  display: none;
}

html[data-theme="localhost"] .sidebar-top-brand strong {
  font-weight: var(--font-weight-medium);
}

html[data-theme="localhost"] .msg-bubble {
  border-color: transparent;
}

html[data-theme="localhost"] .msg.user .msg-bubble {
  background: var(--color-sidebar-mist);
}

html[data-theme="localhost"] .input-area {
  background: var(--color-pure-white);
}

html[data-theme="localhost"] .session-item.active {
  background: var(--color-hover-veil);
}

html[data-theme="localhost"] .agent-tab.active,
html[data-theme="localhost"] .mode-tab.active {
  background: var(--color-hover-veil);
  color: var(--color-graphite-ink);
  font-weight: var(--font-weight-medium);
}
`;

const MOBILE_EXTRA = `
@media (max-width: 728px) {
  .sidebar-top-strip {
    display: none;
  }

  .sidebar-footer {
    display: none;
  }

  .sidebar {
    width: min(85vw, 300px);
    min-width: min(85vw, 300px);
  }

  .chat-header {
    padding: var(--spacing-8) var(--spacing-12);
  }

  .messages {
    padding: var(--spacing-16) var(--spacing-12);
  }

  .input-area {
    padding: var(--spacing-12);
    padding-bottom: max(var(--spacing-12), var(--safe-bottom));
  }

  .mobile-topbar-select {
    display: block;
  }
}

@media (min-width: 729px) {
  .menu-btn {
    display: none !important;
  }

  .mobile-topbar-select {
    display: none !important;
  }
}
`;

function stripPreamble(css) {
  // Remove header, :root, and html[data-theme="localhost"] blocks
  let i = css.indexOf('/* === Reset === */');
  if (i === -1) i = css.indexOf('*, *::before');
  return css.slice(i);
}

function extractMediaQueries(css) {
  const media = [];
  const re = /@media[^{]+\{([\s\S]*?\})\s*\}/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(css)) !== null) {
    const block = m[0];
    if (!seen.has(block)) {
      seen.add(block);
      media.push(block);
    }
  }
  let stripped = css;
  for (const block of media) {
    stripped = stripped.split(block).join('');
  }
  return { stripped, media: [...new Set(media)] };
}

function codexifyFixed(css) {
  let out = css
    .replace(/MotherDuck Neo-Brutalist/g, 'Graphite-on-Paper')
    .replace(/Neo-Brutalist Shared Button Base/g, 'Shared Button Base')
    .replace(/border(-top|-bottom|-left|-right)?:\s*2px/g, 'border$1: 1px')
    .replace(/border:\s*2px/g, 'border: 1px')
    .replace(/border-radius:\s*0\b/g, 'border-radius: var(--radius-nav)')
    .replace(/border-radius:\s*2px/g, 'border-radius: var(--radius-nav)')
    .replace(/border-radius:\s*14px/g, 'border-radius: var(--radius-nav)')
    .replace(/box-shadow:\s*(?!none)[^;]+;/g, 'box-shadow: none;')
    .replace(/transform:\s*translate\([^)]+\);\s*/g, '')
    .replace(/transform:\s*translateY\(-1px\);\s*/g, '')
    .replace(/transform:\s*translateY\(var\([^)]+\)\);\s*/g, '')
    .replace(/text-transform:\s*uppercase/g, 'text-transform: none');

  // Remove scattered localhost overrides from main branch
  out = out.replace(/html\[data-theme="localhost"\][\s\S]*?\}\n/g, '');
  return out;
}

function splitByMarkers(css) {
  const markers = [...css.matchAll(/\/\* === ([^=]+?) === \*\//g)].map((m) => ({
    name: m[1].trim(),
    index: m.index,
  }));

  const chunks = {};
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : css.length;
    chunks[markers[i].name] = css.slice(start, end);
  }
  return chunks;
}

const FILE_MAP = {
  '01-base.css': [
    'Reset',
    'Login',
    'Shared Button Base',
    'Shared text control base',
    'Utility',
  ],
  '02-layout.css': [
    'App Layout',
    'Topbar',
    'Sidebar',
    'Sidebar Resizer',
    'Chat Main',
    'Workspace Insights',
  ],
  '03-chat.css': [
    'Messages',
    'Slash Command Menu',
    'Input Area',
    'Option Picker',
    'Model Picker (Claude Code style)',
  ],
  '04-sessions.css': [
    'Project Groups',
    'New Chat Split Button',
    'Import Session List',
    'New Session Project Picker',
  ],
  '05-panels.css': [
    'Settings Overlay & Panel',
    'Settings Navigation List',
    'Settings Subpage',
    'Force Change Password Overlay',
    'Password Hint',
    'Settings Divider',
    'Settings Section Title',
    'Modal Overlay',
    'Directory Browser',
    'Git Panel',
    'Workspace Insights Components',
  ],
  '06-components.css': [
    'Toast Notification',
    'Connection Status Indicator',
    'Session Unread Dot',
    'Settings Button (topbar)',
    'Chat CWD label',
  ],
};

function build() {
  const raw = fs.readFileSync(SRC, 'utf8');
  let body = stripPreamble(raw);
  const { stripped, media } = extractMediaQueries(body);
  body = codexifyFixed(stripped);

  // Pull login out of 01-base assignment — login goes to 05
  const chunks = splitByMarkers(body);

  // Messages section includes tools/ask — stays in 03
  // Session items are inside Sidebar chunk — move session rules to 04 via post-process
  const files = {};

  files['00-tokens.css'] = TOKENS;

  let base = '';
  for (const key of FILE_MAP['01-base.css']) {
    if (chunks[key]) base += chunks[key] + '\n';
  }
  // Enhance base: body typography, shared controls from Topbar chunk
  base = base.replace(
    'body {',
    `body {
  font-size: var(--text-body);
  line-height: var(--leading-body);`
  );
  if (chunks['Topbar']) {
    const topbar = chunks['Topbar'];
    const shared = topbar.match(/\/\* Shared compact control[\s\S]*?(?=\/\* Topbar icon)/);
    if (shared) base += '\n' + codexifyFixed(shared[0]);
  }
  files['01-base.css'] = `/* 01-base.css — reset, typography, shared inputs & buttons */\n${base}`;

  let layout = '';
  for (const key of FILE_MAP['02-layout.css']) {
    if (chunks[key]) layout += chunks[key] + '\n';
  }
  layout += SIDEBAR_FIRST;
  files['02-layout.css'] = `/* 02-layout.css — app shell, sidebar, workspace */\n${layout}`;

  let chat = '';
  for (const key of FILE_MAP['03-chat.css']) {
    if (chunks[key]) chat += chunks[key] + '\n';
  }
  files['03-chat.css'] = `/* 03-chat.css — messages, input, menus */\n${chat}`;

  let sessions = '';
  // Extract session-related from Sidebar
  if (chunks['Sidebar']) {
    const sb = chunks['Sidebar'];
    const sessionPart = sb.match(/\.session-search-wrap[\s\S]*/);
    if (sessionPart) sessions += '/* === Session List & Items === */\n' + sessionPart[0];
  }
  for (const key of FILE_MAP['04-sessions.css']) {
    if (chunks[key]) sessions += chunks[key] + '\n';
  }
  files['04-sessions.css'] = `/* 04-sessions.css — sessions, projects, import */\n${sessions}`;

  let panels = '';
  // Login from chunk
  if (chunks['Login']) panels += chunks['Login'] + '\n';
  // Session loading from between topbar and sidebar in raw — find in Sidebar preamble
  const loadingMatch = raw.match(/\.session-loading-overlay[\s\S]*?@keyframes session-loading-pulse[\s\S]*?\}/);
  if (loadingMatch) panels += codexifyFixed(loadingMatch[0]) + '\n';
  for (const key of FILE_MAP['05-panels.css']) {
    if (chunks[key]) panels += chunks[key] + '\n';
  }
  // git-panel-toolbar lives in insights components chunk
  files['05-panels.css'] = `/* 05-panels.css — settings, modals, git, insights, login, loading */\n${panels}`;

  let components = '';
  for (const key of FILE_MAP['06-components.css']) {
    if (chunks[key]) components += chunks[key] + '\n';
  }
  files['06-components.css'] = `/* 06-components.css — tools, toasts, status, misc */\n${components}`;

  files['07-themes.css'] = THEMES;

  let mobile = media.join('\n\n');
  mobile = codexifyFixed(mobile) + MOBILE_EXTRA;
  files['08-mobile.css'] = `/* 08-mobile.css — responsive rules */\n${mobile}`;

  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const cleaned = content
      .replace(/\n{3,}/g, '\n\n')
      .replace(/var\(--nb-btn-shadow\):\s*none;/g, '')
      .trim() + '\n';
    fs.writeFileSync(path.join(OUT, name), cleaned);
    console.log(`Wrote ${name} (${cleaned.length} bytes)`);
  }

  // Minimal style.css import barrel (optional)
  const barrel = Object.keys(files)
    .sort()
    .map((f) => `@import url('css/${f}');`)
    .join('\n') + '\n';
  fs.writeFileSync(path.join(ROOT, 'public', 'style.css'), `/* Modular CSS — load via index.html link tags */\n${barrel}`);
}

build();