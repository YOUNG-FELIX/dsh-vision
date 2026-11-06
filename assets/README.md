# Sample images

Fixed test corpus for the measurements in the top-level README. Each was sent **alone**, one
request per image, through the routes named in the README. They were chosen because they hit
exactly the failure modes worth documenting: panel counts, side-view orientation, small identity
details, and verbatim dialogue.

All three come from **deepseek-whale-girl-gallery** — <https://iphsiibl.github.io/deepseek-whale-girl-gallery/>.
Rights remain with the gallery. They are redistributed here only so the documented outputs stay
reproducible; if the gallery asks for removal, delete this directory and the README links stay
valid as plain URLs.

| file | original name | dimensions | bytes | what it stresses |
| --- | --- | --- | --- | --- |
| `sample-chibi-sheet.webp` | `01-chibi-character-sheet-1440w.webp` | 1440×1080 | 173,428 | detail-panel count (8 = 1 large + 3 + 4), side-view orientation (faces left), ornament shape on the trim |
| `sample-mature-sheet.webp` | `02-mature-character-sheet-1440w.webp` | 1440×1080 | 191,194 | right-hand detail column layout (1 wide + 2×2), shoe colour (navy, not black), hair braid at the back |
| `sample-comic.webp` | `06-ds-and-claude-900w.webp` | 900×1200 | 180,792 | verbatim dialogue (6 lines), panel split (top / bottom, not left / right), small identity details (horn, flower pin, sauna-stone bucket) |

## Reproducing a measurement

```bash
# text only — cheap, and the one case where all routes agree
vision_read(path: "<abs>/sample-comic.webp", task: "text")

# full description — expensive, and the one case where the details come back
vision_read(path: "<abs>/sample-chibi-sheet.webp", task: "describe")

# the anti-pattern: several images in one call degrades counts and orientations
vision_read(paths: ["<abs>/sample-chibi-sheet.webp", "<abs>/sample-mature-sheet.webp"], task: "describe")
```

The third form is supported and sometimes what you want — but if the question involves a count, a
panel split or a direction, send one image per call and compare.

## Screenshots (`shot-*.webp`)

Not test corpus — documentation of the panel and of a real session. These are captures of the DSH
desktop client itself, MIT-licensed with the rest of this directory's code, and carry no third-party
rights.

The four `shot-client-*.webp` files come from a session running on a **text-only** model, which is
the situation the plugin exists for. The account name and avatar in the bottom-left corner of each
were blurred out and then painted over with the sidebar colour, so nothing recoverable remains.

| file | what it shows |
| --- | --- |
| `shot-panel.webp` | the Vision panel itself — status, route, fallbacks, counters |
| `shot-client-toolcall.webp` | `vision_read` in the transcript: three paths in, text out, host model picker visible in the background |
| `shot-client-chibi.webp` | result for the Q-version sheet — panel count correct |
| `shot-client-mature.webp` | result for the adult sheet — the 2×2 detail block, the case a merged multi-image call got wrong |
| `shot-client-comic.webp` | result for the comic — verbatim dialogue correct, spatial claims wrong |
