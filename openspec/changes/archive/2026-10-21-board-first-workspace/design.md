# Design

## Context

`src/public/index.html` currently places membership lists, study buttons, a large drawing toolbar, the canvas, and diagnostic panels in one vertical flow inside a 64rem card. At 1280×720 the canvas begins below the first viewport. Existing JavaScript binds actions by element ID or data attributes.

## Goals / Non-Goals

**Goals:** Preserve bound elements and place the canvas in a wide primary column, with secondary controls in a scrollable side column. Give the drawing toolbar compact but readable controls. Use one responsive layout for desktop and mobile.

**Non-Goals:** Change Canvas coordinates, Yjs state, transport, authentication, image processing, or diagnostic data. No new frontend dependency.

## Decisions

- Keep the existing static HTML and CSS. Move existing elements into a two-column workspace while retaining their IDs. Pass the secondary action container to the Canvas binding because it currently queries those buttons inside the drawing toolbar. A component rewrite would add risk to the many other event bindings for no layout benefit.
- Give the canvas a larger intrinsic bitmap and responsive CSS width with preserved aspect ratio. A CSS-only stretch of the old 800×480 bitmap would make the primary surface blurry.
- Make the side column independently scroll on desktop. At narrow widths it follows the board in normal document flow, so all controls remain reachable.
- Keep the replica pause buttons in the side column under an explicit Experimento mode. The board opens in Quadro mode; the study catalog and references belong to Estudo. CSS hides inactive groups so all diagnostic collectors can keep observing the same live session.

## Risks / Trade-offs

- A larger canvas changes the viewport area. Verify pointer interactions and PNG export in the browser after resizing.
- Moving study and diagnostic nodes can affect selectors or clicks. Retain their IDs and run focused browser checks on the actual page.
- On narrow screens the canvas necessarily gets smaller. Preserve its aspect ratio and let the document scroll vertically.

## Verification notes

- Baseline capture at 1280×720: the canvas was below the initial viewport and its CSS width was capped at 800 px.
- Revised page at 1280×720: canvas bounds `x=25.6`, `y=260.5`, `width=892.8`, `height=536.5` px; side column width 320 px; intrinsic canvas size 1200×720.
- At 390×844: canvas bounds `x=11.2`, `y=377.8`, `width=367.6`, `height=221.4` px. Document scroll width equals viewport width, 390 px. Toolbar client and scroll heights are equal, so its controls are not clipped.
- In the live page, a rectangle appeared in the local replica, PNG export downloaded without error, gallery opened and closed, zoom changed the rendered canvas, VPS and P2P pause/resume controls updated their status, and history listed retained snapshots and events.
- The image upload button and Ctrl+V guidance appear in the drawing toolbar; the processor diagram gallery is in Estudo. A real-page browser test inserted one gallery diagram and one clipboard image; both became board image elements. At 1280×720 the canvas started at y=300 px before the mode split. The study reference remained usable at 390 px after the split, without horizontal overflow.
- VPS and P2P each have one toggle button. The replica browser test exercised both directions, mounted the panel with an already paused session, remounted it, and resumed both transports through the session API while checking the labels.
- Quadro, Estudo, and Experimento switch only the side controls via CSS; the same Canvas node and board session stay active. The real board page test checked the default Quadro mode, gallery insertion in Estudo, diagnostics in Experimento, and Canvas identity after switching back.
