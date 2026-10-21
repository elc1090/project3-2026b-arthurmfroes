# Tasks

## 1. Board layout

- [x] 1.1 Compact the page header and move drawing into a wide primary column with secondary board panels in a side column; verify at 1280×720 that the canvas appears in the initial viewport and is wider than the side column.
- [x] 1.2 Increase the canvas bitmap size without distorting its CSS aspect ratio; verify drawing a rectangle and PNG export still work in the browser.

## 2. Responsive behavior

- [x] 2.1 Adapt the workspace for a 390×844 viewport; verify with Playwright that the page has no horizontal overflow and that drawing and secondary controls remain reachable.
- [x] 2.2 Verify a representative set of existing controls (membership, study, P2P/VPS pause, history) still works from the reorganized page, and record the before/after canvas geometry in the change notes.

## 3. Image controls

- [x] 3.1 Keep image upload and clipboard paste guidance with the drawing tools, and processor diagrams one mode away in Estudo; verify paste and gallery insertion on the real board page.
- [x] 3.2 Replace each pause/resume button pair with one state-aware control; verify local and external session changes plus a remounted panel.

## 4. Separate product controls

- [x] 4.1 Add distinct Quadro, Estudo, and Experimento sidebar modes, default to Quadro, and keep the same Canvas mounted across mode changes.
- [x] 4.2 Move processor templates and learning controls to Estudo, keep generic image paste/upload in Quadro, and keep replica diagnostics in Experimento; verify all three on the real board page.
