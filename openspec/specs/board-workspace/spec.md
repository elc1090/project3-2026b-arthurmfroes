# board-workspace Specification

## Purpose

Defines how the board page gives drawing space visual priority while keeping membership, study, and synchronization controls available on desktop and narrow screens.

## Requirements

### Requirement: Canvas-first workspace
The system SHALL make the drawing canvas the largest area of the signed-in board page and show it without scrolling past secondary panels at common desktop viewport sizes.

#### Scenario: Open a board on desktop
- **WHEN** a member opens a board at a 1280×720 viewport
- **THEN** a substantial portion of the canvas appears in the initial viewport and the canvas occupies more horizontal space than the secondary controls

### Requirement: Secondary controls remain accessible
The system SHALL keep board membership, study tools, synchronization diagnostics, and experiment controls available beside or below the canvas without obscuring drawing interactions.

#### Scenario: Use a secondary control
- **WHEN** a member opens a board and accesses a secondary panel
- **THEN** its existing actions remain usable while the canvas remains visible

#### Scenario: Add a processor diagram or clipboard image
- **WHEN** a member opens a board
- **THEN** image upload and clipboard paste are available with the drawing tools, while the processor diagram gallery is available from the study area without losing the open board

#### Scenario: Pause or resume a transport
- **WHEN** a member pauses or resumes VPS or P2P synchronization in this browser
- **THEN** one control per transport shows the next available action from the current session state, including after the panel is mounted again

### Requirement: Narrow-screen workspace
The system SHALL adapt the board page to narrow viewports without horizontal page overflow or unreachable board controls.

#### Scenario: Open a board on a phone-sized screen
- **WHEN** a member opens a board at a 390×844 viewport
- **THEN** the canvas, drawing tools, and secondary controls remain reachable without horizontal page scrolling

### Requirement: Separate board, study, and experiment controls
The system SHALL open a board in a drawing-focused mode. The member SHALL be able to reveal study content or replica diagnostics from distinct sidebar modes while the same Canvas and collaboration session remain active.

#### Scenario: Open drawing mode
- **WHEN** a member opens a board
- **THEN** study formulas, processor templates, replica previews, and experiment measurements are absent from the primary board controls

#### Scenario: Switch sidebar mode
- **WHEN** a member switches among Quadro, Estudo, and Experimento
- **THEN** the selected controls become visible without remounting the Canvas or reconnecting the board session
