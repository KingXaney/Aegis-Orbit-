# Make interfaces feel better: home page review (2026-10-17)

| Check | Result |
|---|---|
| Concentric border radius | Pass: sheet 12 → rows 8 inset 4; pass card 12 |
| Optical alignment of icons | Pass: one 16 px grid, 1.5 stroke; search icon centred in 40 px field |
| Shadows over borders | Pass: floating sheets use layered shadows; static surfaces keep a hairline for structure |
| Split and staggered enter | Intentionally single: one orchestrated moment (shells light up, magenta line draws in) |
| Subtle exits | Pass: sheets and cards leave without motion |
| Tabular numbers | Pass: countdowns and distances in IBM Plex Mono, counts in B612 tabular figures |
| Font smoothing | Pass (antialiased at root) |
| text-wrap balance / pretty | Pass: headings balance, paragraphs pretty |
| Scale on press | Pass: buttons and the pass card scale 0.97; disabled under reduced motion |
| No `transition: all` | Pass: every transition names its properties |
| will-change | Not used; no first-frame stutter observed |
| 40 × 40 hit areas | Pass after fixing the 13 px root; links extend with ::after |
