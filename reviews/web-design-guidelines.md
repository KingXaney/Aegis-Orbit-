# Web Interface Guidelines: home page (2026-10-17)

## frontend/src/explorer/ExplorerPage.tsx
✓ pass

## frontend/src/explorer/Approaches.tsx
frontend/src/explorer/Approaches.tsx:260 - column headings are aria-hidden; row labels carry the same information (intentional)

## frontend/src/explorer/FindBox.tsx
✓ pass

## frontend/src/explorer/FilterPanel.tsx
✓ pass

## frontend/src/explorer/DetailsCard.tsx
✓ pass

## frontend/src/index.css
✓ pass

## Deliberate deviations
- Headings and buttons use sentence case, not Title Case: the cockpit voice of the page.
- Filters and a pinned pass are not reflected in the URL; the selected object is (`?object=`).
- `translate="no"` is not yet set on object names and NORAD IDs.
