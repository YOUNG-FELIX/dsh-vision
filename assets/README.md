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
