# board-content Specification

## Purpose

Defines the whiteboard capabilities that remain available when the existing product gains accounts, multiple boards, and distributed collaboration.

## Requirements

### Requirement: Multiple isolated boards
The system SHALL let a signed-in person create a board with its own title, stable link, content, and membership.

#### Scenario: Create two boards
- **WHEN** a signed-in person creates two boards and draws on only one of them
- **THEN** each board has a distinct link and the other board remains unchanged

### Requirement: Existing drawing tools
The system SHALL preserve freehand pen and highlighter strokes, lines, arrows, rectangles, MUX and ALU symbols, text, colors, stroke sizes, selection, movement, erasing, and clearing a board.

#### Scenario: Draw and edit
- **WHEN** a member creates each supported element type and moves or erases an applicable element
- **THEN** the board displays the resulting elements and edits to all connected members

#### Scenario: Erase part of a stroke
- **WHEN** a member passes the eraser through a freehand stroke
- **THEN** the visible stroke is clipped as in the original product

#### Scenario: Eraser passes over an image
- **WHEN** a member passes the eraser over a placed image
- **THEN** the image remains on the board, as in the original product

### Requirement: Pointer input parity
The system SHALL support drawing interactions from mouse, touch, and stylus input.

#### Scenario: Stylus drawing
- **WHEN** a member draws a stroke using a stylus
- **THEN** the stroke is rendered and shared like a mouse-created stroke

### Requirement: Stable visual stacking
The system SHALL render board elements in a consistent stacking order for all members.

#### Scenario: Overlapping elements
- **WHEN** two elements overlap on a board
- **THEN** connected members see them in the same front-to-back order after synchronization

### Requirement: Images and study templates
The system SHALL preserve image insertion from a local file, clipboard, and the existing study-template gallery; authorized members SHALL see the same placed images after synchronization.

#### Scenario: Insert image from clipboard
- **WHEN** a member pastes an image into a board while connected
- **THEN** other authorized members can see the image at the same position and size

#### Scenario: Load study template
- **WHEN** a member chooses an existing diagram from the gallery
- **THEN** the diagram is added to that board without removing its existing elements

### Requirement: Local image insertion during disconnection
The system SHALL keep an image added while disconnected visible to its author and SHALL publish it to other authorized members after the image has been uploaded on reconnection.

#### Scenario: Paste image without server connection
- **WHEN** a member pastes an image while unable to reach the VPS
- **THEN** the image remains available locally, including after reopening the browser, and appears for other members after reconnection and upload

### Requirement: Local viewport and editing history
The system SHALL preserve pan, zoom, fit-to-content controls, and undo/redo for the member's own board actions without undoing another member's independent actions.

#### Scenario: Personal viewport
- **WHEN** one member pans or zooms their view
- **THEN** another member's viewport does not move

#### Scenario: Undo own change
- **WHEN** a member undoes their last local action after another member has made an independent edit
- **THEN** the other member's edit remains on the board

### Requirement: Existing study and export flows
The system SHALL retain the study sidebar and gallery, local PNG export, the manual board-image save used for AI analysis, and display of saved AI feedback.

#### Scenario: Export current board
- **WHEN** a member exports the board as PNG
- **THEN** the downloaded image contains the member's current visible board content

#### Scenario: Save board image for analysis
- **WHEN** a member explicitly saves the current board image for AI analysis
- **THEN** the server stores that board's image and the existing feedback view remains available
