# osu! Beatmap Listing Pagination

Replaces the infinite scroll on https://osu.ppy.sh/beatmapsets with numbered pages (50 maps each).

- The page number lives in the URL (`?page=N`), so going Back from a beatmap returns you to the same page.
- The last page you were on is remembered per search (sort + filters), so opening the listing again picks up where you left off.
- Date filter bar for **Ranked**, **Submitted** (osu!'s `created`/`submitted`) and **Updated**. Each opens a calendar: click the start day, then the end day. You can also type dates, jump by month/year, or use presets (whole month, whole year, last 30 days, last 12 months). It writes the matching `ranked>=2010-08-01 ranked<2010-11-01` terms into the search box for you; both picked days are included.
- Click a thumbnail to play the song preview; click the title to open the beatmap.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder

After editing the files, press the reload icon on the extension's card and refresh the osu! tab.

## Notes

- All osu!'s own filters and sorts keep working; a search you haven't paged through before starts at page 1.
- osu! search stops at 10,000 results, so there are at most 200 pages.
- Sorting, text search and the date filter only apply when you're signed in to osu!.
