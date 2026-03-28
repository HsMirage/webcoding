# Project Workspace

## 🚨 CRITICAL INITIALIZATION PROTOCOL 🚨

**HIGHEST PRIORITY DIRECTIVE**: 
At the start of every new session, regardless of the user's first input (even a simple "Hello" or "你好"), before you generate ANY text response or take any other action, you **MUST IMMEDIATELY and AUTOMATICALLY use the file reading tool** to load and process the following four files:

1. `RULES_GLOBAL.md`
2. `PROJECTS_INDEX.md`
3. `DESC_ENV.md`
4. `DESC_DIR.md`

**Strict Execution Standards:**
- **DO NOT** ask the user "Should I read them now?" or "Do you want me to load the files?".
- **DO NOT** reply to the user's greeting first.
- Your absolute FIRST action in the session MUST be a tool call to read these exact files.
- Only AFTER successfully reading these files may you respond to the user's initial prompt, using the context you just acquired.

## Key Files

*   `GEMINI.md`: This file, providing contextual instructions for Gemini CLI in this workspace.

