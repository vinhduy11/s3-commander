# Rules

No project-specific conventions yet. The global rules in `~/.claude/rule.md` apply. Add Rust and frontend naming/style conventions here once the stack is chosen.

## UI conventions

- Design direction: **Modern** (contemporary desktop look in the spirit of Finder, Linear and Raycast): soft cool-grey surfaces, hairline borders, gentle shadows, rounded corners, one indigo accent, crisp stroke icons, short restrained transitions. File rows stay dense (22px), never cards.
- All colors, type sizes, spacing, radius and motion live as CSS custom properties in `src/tokens.css`; `src/styles.css` uses only `var(--...)`, no raw hex. Add or change a value in the tokens file first.
- Theme follows `prefers-color-scheme` (light and dark defined in `tokens.css`); there is no toggle.
- Icons are inline SVG components in `src/icons.tsx` (stroke, `currentColor`, tinted by token). No icon font, no image CDN.
- Offline rule: the desktop app makes no runtime network request for UI assets. System font stack (`system-ui`, `ui-monospace` for lists) only; if a font is ever wanted, bundle the file under `src/` and reference it locally, never Google Fonts or a CDN.
- WebKit (macOS and Linux webviews) is the target: avoid CSS that WebKit lacks; progressive features only (e.g. `::-webkit-scrollbar` is used for a fixed-width list scrollbar so the column header stays aligned).
- Visual changes must not touch store logic, commands or keyboard handling.
