# Kanplete

Kanban boards for Obsidian that you never have to see as markdown. You edit cards in a proper window, with fields for the title, description, subtasks, tags, due date, colour and icon. Underneath, each board is still an ordinary markdown file you can read, search, link to and sync.

<!-- Screenshots: add images to docs/ and uncomment
![A board](docs/board.png)
![The card editor](docs/editor.png)
![A live column inside a daily note](docs/live-column.png)
-->

## Features

**Boards**
- Columns and cards you drag around. Switch between a column layout and a row layout, per board.
- The board title is the file name. Double-click it to rename the file.
- Filter cards by text or `#tag`.
- Pick a "done" column, and cards moved there are ticked off automatically.
- Undo and redo.

**Cards**
- **Card editor:** title, description, subtasks, tags, due date, done state, icon and colour. Use "Add & new" to enter several cards in a row.
- **Smart titles:** type `Leg day tomorrow #gym` and the date and tag are filled in for you. Understands today, tomorrow, weekday names, "next week", "in 3 days" and `@2026-12-01`.
- **Due dates:** overdue cards turn red. The board rechecks dates at midnight on its own.
- **Comments:** kept in a popup, never on the card face. A small icon in the corner shows how many there are.
- **Blocked by:** link a card to the cards it waits on. It stays greyed out until they are done.
- **Fading:** cards nobody has touched for a while (21 days by default) fade, so forgotten work stands out.
- **Templates:** save any card as a template and pick it when adding a new one.
- **Archive:** archived cards leave the board but stay in the file. Restore or delete them from the archive window.

**Across your vault**
- **Due cards panel:** a sidebar listing overdue cards, cards due today and cards due in the next 7 days, from every board.
- **Quick add:** add a card to any board from anywhere. Selected text becomes the card's title.
- **Live columns in notes:** put one column of a board inside any note, for example your daily note. It is fully usable there: tick cards, add cards, drag them.
- **Daily note log** (off by default): finished cards are listed under "Done today" in today's daily note.

## Getting started

1. Run **Kanplete: New board** from the command palette, or right-click a note and choose to open it as a board.
2. Add columns and cards. Double-click a card to edit it.
3. Run **Kanplete: Insert board column into note** to show a column inside a note.

## Commands

| Command | What it does |
| --- | --- |
| New board | Creates a board and opens it |
| Quick add card | Adds a card to any board, from anywhere |
| Insert board column into note | Puts a live column at the cursor |
| Show due cards | Opens the due cards panel |
| Switch layout (columns / rows) | Changes the current board's layout |
| Focus mode (hide sidebars) | Gives the board the whole window |
| Toggle board / markdown | Shows the current file as a board or as plain markdown |

## How boards are stored

A board is a markdown note with `kanban: true` in its frontmatter. Each `## ` heading is a column and each `- [ ]` item is a card:

```markdown
---
kanban: true
---

## To do

- [ ] Plan training block #gym @2026-11-17 [color:: red] [icon:: dumbbell]
    Push / pull / legs split
    - [ ] Pick exercises
    - [x] Decide days

## Done

- [x] Pick next book #books
```

Extra details are kept in `[field:: value]` notes on the card's line. Comments are indented lines beginning with `>`. Archived cards are kept in a hidden `## Archive` section at the end of the file.

A live column in a note is a code block:

````markdown
```kanplete
board: Workouts
column: This week
```
````

Leave out `column:` to show the whole board. If you rename the board, Kanplete updates these blocks for you.

## What Kanplete writes to your files

Kanplete only changes files in the following cases:
- **Boards:** whenever you edit them through Kanplete. While fading is on, an edited card also gets an `[updated:: date]` note. Set "Fade untouched cards" to Off to stop this.
- **Your daily note:** only when "Log finished cards in your daily note" is turned on. Kanplete then adds or removes lines under a "Done today" heading. It uses the folder and date format from the Daily notes core plugin.
- **Notes with live columns:** the `board:` line of a `kanplete` code block, when that board is renamed.

Kanplete makes no network requests and collects no data.

## Install

**From Community plugins (once listed):** Settings, then Community plugins, then Browse. Search for "Kanplete".

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Connor-Ve/kanplete/releases/latest). Put them in `<your vault>/.obsidian/plugins/kanplete/`, then turn the plugin on under Community plugins.

## Known limitations

- On phones and tablets, cards can't be dragged yet. Use the card menu to move them.

## License

[MIT](LICENSE)
