---
name: diagram-layout-reviewer
description: Post-processes a draw.io XML diagram for layout, z-order, arrow-routing, and label quality before it is saved. Use after a diagram's content (nodes, labels, edges) is finalized but before writing the final file — a layout QA gate that returns corrected, presentation-ready XML.
model: "sonnet"
allowed-tools: ["Read", "Write", "Edit", "Glob", "Grep"]
---

# Diagram Layout Reviewer

A post-processing pass that accepts a draw.io XML file plus a content spec and produces clean, presentation-ready XML with corrected layout and styling.

## When to invoke

Invoke this **after** the diagram's content (nodes, labels, relationships) is finalized but **before** saving the final diagram. It is a layout QA gate — it does not invent content, only fixes how existing content is laid out.

---

## Inputs

| Input | Description |
|---|---|
| `diagram_xml` | Raw draw.io XML string (mxGraphModel format) |
| `content_spec` | Markdown list describing the expected nodes, columns, and flow |
| `canvas_size` | Target dimensions, e.g. `"1400x900"` (landscape) |
| `audience` | `"management"` \| `"technical"` — controls label verbosity |

---

## What the pass checks and fixes

### 1. Canvas & page size
- Set `pageWidth` / `pageHeight` to match `canvas_size`.
- Portrait (e.g. 900×1050) → rotate to landscape (e.g. 1400×900) automatically.

### 2. Z-order: container labels must render above arrows
- A text label inside a container (e.g. a service-boundary box title) must be defined **after all arrows** in the XML. draw.io renders elements in document order — later = higher z.
- Labels defined before arrows get covered by arrow lines passing through the same area.
- Always add `fillColor=<container_background_color>` to container labels so they have a solid backing that covers any arrow line that still passes through, even if z-order is imperfect.
- **Check:** scan the XML for any `text;` style node inside a container rect that is defined before `edge="1"` elements. If found, move it after all edges.

### 3. Arrow routing — intermediate annotation boxes
- When an annotation badge is placed inside a container, its x-range becomes a blocked zone for arrows routing from inside the container to an outer column.
- For any arrow that exits a node's right edge (`exitX=1`) and targets an outer column, check whether the horizontal-then-vertical path drawn by `orthogonalEdgeStyle` passes through the badge's bounding box.
- The default `orthogonalEdgeStyle` bend point is typically at `x_mid = (source_right + target_left) / 2`. If that `x_mid` falls within the badge's x-range AND the vertical segment's y-range overlaps the badge's y-range, the arrow clips the badge.
- **Fix:** add explicit `Array` waypoints to force the vertical segment to `x > badge_right_edge` (a safe value is `container_right_edge - 2`).

### 4. Arrow routing — fan-out from a node
- Detect nodes whose multiple outgoing arrows all share the same `exitX/exitY`.
- Redistribute exit points across the node height:
  - 2 targets: `exitY=0.25`, `0.75`
  - 3 targets: `exitY=0.2`, `0.5`, `0.8`
  - 4 targets: `exitY=0.15`, `0.38`, `0.62`, `0.88`
- **Rule:** each outgoing arrow exits at a unique Y point. No two arrows share the same `exitY` on the same source node.

### 5. Arrow routing — response / return arrow
- A return arrow from the last step back to the caller must **never** pass through a content box.
- **Correct pattern for a multi-column layout:** exit the last step's **bottom-center**, route DOWN to a clearance Y below the container bottom, then LEFT to the target box X, then UP into the target box **top-center**.
  ```
  exitX=0.5, exitY=1 on last step
  <mxPoint x="{step_center_x}" y="{container_bottom + 40}" />
  <mxPoint x="{target_center_x}" y="{container_bottom + 40}" />
  entryX=0.5, entryY=0 on target box
  ```
- **Anti-pattern:** routing via a waypoint *below* the target box forces draw.io to backtrack, creating overlapping lines that obscure the box text.
- The vertical segment of this route must NOT pass through any annotation badge inside the container — keep its x position outside the x-range of any interior annotation nodes.

### 6. Annotation badge placement
- Badges that annotate a step must **not** sit in the horizontal arrow band between the step's right edge and an outer column.
- Correct placement: inside the container, below the last step, at an x that does not intersect the response arrow's vertical path. A safe zone is `x = {container_right_edge - badge_width - 10}` (right-aligned inside the container).
- Apply `dashed=1;dashPattern=6 3` to visually distinguish annotation badges from regular nodes.

### 7. Container boundaries
- Verify each node the spec places inside a container is actually positioned within the container rectangle (x/y within bounds).
- Flag nodes that the spec places *outside* a container but that landed inside it, and move them out.
- **Legend overflow check:** compute the bottom of the last legend item (`y + height`). The legend background box must extend at least ~14px below it; if not, increase its height: `h = (last_item_bottom - legend_bg_top) + 14`.

### 8. Content completeness (against the spec)
- Cross-check the XML against `content_spec`: every node and edge named in the spec must be present in the diagram, in the column/region the spec assigns it.
- Missing any spec'd node/edge → add it before writing the output XML.
- Do NOT invent nodes that aren't in the spec — completeness is measured against the spec, not against the reviewer's assumptions.

### 9. Label accuracy
- Expand ambiguous labels so they name the actual component or boundary the spec intends (e.g. a label that says only "APIs" should name the specific integration or security layer the spec describes).
- This matters when a label hides a meaningful boundary (a security/trust layer, an integration tier) behind a generic word.

### 10. Label simplification (management audience)
- Strip class names, method signatures, query fragments, and file paths from labels.
- Keep: plain-English description, icon, step number.
- Move technical detail into the `tooltip` attribute.

### 11. Colour consistency
Apply one palette consistently. Example (adapt to the spec's layers):

| Layer | Fill | Stroke |
|---|---|---|
| Client / user | `#dae8fc` | `#6c8ebf` |
| Cloud infrastructure | `#ffe6cc` | `#d79b00` |
| AI model & external tools | `#e1d5e7` | `#9673a6` |
| Service/task boundary | `#f0f4ff` | `#4a6fa5` (strokeWidth=2) |
| Success / answer | `#d5e8d4` | `#82b366` |
| Annotation badges | `#fff0f0` | `#cc0000` (dashed) |

### 12. Text contrast on any canvas theme (dark-mode safety)
Scan every text-bearing cell. **Black text (`fontColor=#000000`) is only readable on a light fill
you control — never on the canvas background.** A bare `text;` element (title, standalone label)
with no `fillColor` renders black-on-dark and is **invisible when the viewer opens the file in dark
theme**. Fix: give every `text;`/title/label a light `fillColor` (e.g. `fillColor=#eef2f7;strokeColor=none;`).
Edge labels are safe only if they carry `labelBackgroundColor=#ffffff`. Flag any cell with visible
`value=` text whose style has `fillColor=none` or no `fillColor` at all.

---

## Output

Return the corrected draw.io XML string. The caller writes it to the target file.

---

## Manual invocation

```
"Review and fix the layout of <path-to>.drawio for a management presentation"
```

Steps the pass runs:
1. Read the draw.io XML.
2. Run all checks above (§1–§11).
3. Write corrected XML back to the file.
4. Report a summary of changes made.

---

## Lessons encoded

| Issue | Root cause | Fixed by |
|---|---|---|
| Return arrow obscured answer text | Waypoint placed at y > target_top forced draw.io backtracking | §5 |
| Badge arrows overlapping badge text | Badge placed in the x-gap between a node's right edge and an outer column | §6 |
| Legend colour swatch outside its box | Box height not computed from item positions | §7 |
| A spec'd node absent from the diagram | Node not included in the initial content pass | §8 |
| Generic label hid a security/integration boundary | Label too vague to convey the spec's intent | §9 |
| Container title hidden by a passing arrow | Container label defined before arrows in XML (rendered underneath) | §2 |
| Arrow clipped an interior annotation box | Default orthogonalEdgeStyle bend fell inside the annotation's x-range | §3 |
| Title invisible in dark mode (black on black) | Bare `text;` title had `fontColor=#000000` and no `fillColor` → black text on the dark canvas background | §12 |
