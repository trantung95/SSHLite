# Lessons Learned

AI assistants must read this file at the start of every session and apply all lessons.
Add new entries as bugs are found, mistakes are made, or better approaches are discovered.

---

## 2026-05-07 — Lifting JS out of a template literal needs a THREE-step unescape, not two

**What happened**: Phase 1 of the search-render-overhaul (v0.8.1) lifted the inline `<script>` body from `SearchPanel.getWebviewContent()` (a template literal) into `webview-src/search/index.ts`. The unescape pass handled `` \` → ` `` and `\${ → ${` but missed `\\u → \u` (and `\\u{` → `\u{`). After the lift, every emoji and special character (server status icons 🔄 ❌ 🟢 ⚡ ⚫, path icons 📄 📁, warning ⚠️, remove/close ×, sort ↑, tooltip em-dashes —) rendered as literal escape text like `\u{1F504}` in the UI. Three reviewers (Task 6 spec + quality, then a holistic Phase 1 review) examined the lift; only the holistic final review caught this. Manual smoke test (Task 11) was skipped per user request — that gate would have caught it in 30 seconds.

**Root cause**: A string literal inside a template literal is double-evaluated: once by the template literal itself, then again by the inner JS engine when the template's string is loaded as code. So the original `'\\u{1F504}'` in the template-literal source produced `'\u{1F504}'` at template-output time, which the webview's JS engine then parsed as the emoji. After lifting to a real `.ts` file, only one level of evaluation happens — `'\\u{1F504}'` becomes literal text `\u{1F504}` (9 chars), never interpreted as a unicode escape.

**Lesson**:
- When lifting any JS body out of a template literal into a real source file, the unescape pass must include **all** template-literal escape sequences, not just backticks and `${`. At minimum: `` \` ``, `\${`, `\\u`, `\\u{`, `\\xHH`, `\\n`, `\\r`, `\\t`, `\\\\` (literal backslash). Run a grep for `\\\\` in the source after the lift; every hit is a candidate for the same regression.
- Per-task code reviewers can miss UI-rendering bugs because they don't run the UI. The **manual smoke test** is the only reliable gate for this class of bug. If the user opts to skip manual smoke, flag the unicode/escape-sequence risk explicitly in the report so they can run a targeted check (e.g. open the panel and verify icons render).
- Add a one-liner check to any future webview-lift plan: `grep -nE '\\\\[a-zA-Z0-9{]' webview-src/<dir>/index.ts` should return zero hits after the unescape; any hit is a regression risk.
