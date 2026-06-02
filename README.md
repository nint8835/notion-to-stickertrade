# notion-to-stickertrade

`notion-to-stickertrade` is a utility script that uses the Notion API & a reverse-engineered version of [stickertrade](https://stickertrade.ca/)'s API, to mirror my existing sticker collection I track in a Notion database to [my profile on stickertrade](https://stickertrade.ca/profile/nint8835).

## Running

By default, Sticker Trade interactions are stubbed out. The script still reads
from Notion, but treats the Sticker Trade profile as empty and logs each sticker
it would upload instead of writing to Sticker Trade.

```sh
npm start
```

To use the real Sticker Trade integration, opt in explicitly:

```sh
npm run start:live
```

## Environment

Required for Notion reads:

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `NOTION_COUNT_PROPERTY_ID`
- `NOTION_EXCLUDE_PROPERTY_ID`

Optional for Notion reads:

- `NOTION_DATA_SOURCE_ID` - skips resolving the database's first data source

The Notion token must be a connection token with access to the database. The
script reads each sticker image from the first image block on its Notion page.

Required only when `STICKERTRADE_MODE=live`:

- `STICKERTRADE_USERNAME`
- `STICKERTRADE_COOKIE`
