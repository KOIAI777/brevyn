---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
version: "2.1.0"
---

# PPTX Skill

## Brevyn Office Authoring Protocol

Use this protocol before choosing a lower-level PPTX technique.

### Runtime gate

- In Brevyn, call `office_runtime` with `prepare=true` before the first LibreOffice conversion or visual QA operation in a run.
- Use `selfTest=true` when conversion previously failed or the runtime may be damaged, then retry the shared preflight.
- Do not ask the user to install LibreOffice while the bundled runtime reports `ready` or `available`.

### Route the task

- **Read or inspect an existing PPTX**: resolve the Brevyn file record, then use source-derived text, speaker notes, slide previews, and raw OOXML only as needed.
- **Lightweight edit of an existing PPTX**: use this `pptx` skill. Preserve the original deck's theme, layout, typography, slide size, notes, and visual rhythm unless the user asks for restyling.
- **Create a full new deck from papers, reports, course materials, articles, or research sources**: prefer `ppt-master`, because it has the full planning, style confirmation, asset extraction, and generation workflow.
- **Create a small simple deck from scratch**: this skill may be used when the user wants a lightweight PPTX and does not need the full `ppt-master` workflow.
- **Template-following task**: treat the supplied deck as the visual authority. Do not mix in unrelated design systems.

### Source and cache policy

- Treat the PPTX source file as the factual authority.
- Brevyn parsed Markdown is the default readable source when available and current. `artifactPath`, `semanticUnitsPath`, slide semantic units, speaker notes, and PDF/slide previews are used to verify exact structured evidence and layout-sensitive claims.
- If the user asks about exact slide layout, images, speaker notes, hidden content, comments, charts, or theme fidelity, inspect the source deck or rendered slides rather than relying only on text extraction.
- Do not answer from thumbnails alone when text, notes, or source-derived artifacts are needed.

### Output and QA gate

Before delivering a created or edited PPTX:

1. Save the final `.pptx` under the requested path or a clear `outputs/` path.
2. Run the shared preflight when the environment is uncertain:
   `python ../_shared/office/office_preflight.py --json`
3. Run text extraction to check slide order, missing content, and leftover placeholders.
4. Run the unified Office QA report:
   `python ../_shared/office/office_qa_report.py output.pptx --json`
   Use its slide inventory, speaker-note inventory, rendered PDF/page previews, and contact sheet for verification.
5. For PPTX-specific visual debugging, optionally run:
   `python scripts/pptx_render_check.py output.pptx --json`
6. Inspect the rendered slides or contact sheet.
7. Fix severe defects before delivery: text overlap, clipped text, broken images, missing charts, unreadable contrast, placeholder text, incorrect slide size, bad speaker notes, or footer/source collisions.
8. If render QA is unavailable, say that visual render QA was skipped and report the checks you did complete.

Final response should link only the final PPTX unless the user asks for QA intermediates.

## Brevyn Workspace Reading Protocol

When the PPTX comes from a Brevyn course/task workspace, use Brevyn's structured parsed sources before falling back to manual binary extraction.

1. Call `list_course_files` or `get_file_record` to locate the file record.
2. If parsed Markdown is available, call `read_parsed_file` and read the complete file. Follow `nextOffset` until `truncated=false` unless the user asked for only a narrow excerpt.
3. If the record reports `hasOfficeArtifact=true`, use `artifactPath` and `semanticUnitsPath` to verify exact structured evidence.
4. Use `semanticUnitsPath` for exact anchors:
   - `slide` for slide-level text and citations.
   - `speaker_notes` for speaker-note text tied to a slide.
   - `chart` for embedded chart references.
   - `table` or `slide_region` when available from richer PPTX/object extraction.
5. Check slide text, speaker notes, embedded images, charts, tables, hidden slides, themes, masters/layouts, and rendered previews before saying material is missing.
6. Use LibreOffice/PDF preview for visual layout checks; do not treat thumbnails as the primary text source when structured parsed content exists.

If no Brevyn parsed artifact is available, continue with the normal PPTX workflow below: text extraction, thumbnail/render inspection, or raw OOXML depending on the task.

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.**

Use when no template or reference presentation is available.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### Visual QA

**⚠️ USE SUBAGENTS** — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images:
1. /path/to/slide-01.jpg (Expected: [brief description])
2. /path/to/slide-02.jpg (Expected: [brief description])

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Converting to Images

Convert presentations to individual slide images for visual inspection:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## Dependencies

- `pip install "markitdown[pptx]"` - text extraction
- `pip install Pillow` - thumbnail grids
- `npm install -g pptxgenjs` - creating from scratch
- LibreOffice (`soffice`) - PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- Poppler (`pdftoppm`) - PDF to images
