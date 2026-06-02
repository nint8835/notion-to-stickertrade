# notion-to-stickertrade

`notion-to-stickertrade` is a utility script that uses the Notion API and [stickertrade](https://stickertrade.ca/)'s official JSON API, to mirror my existing sticker collection I track in a Notion database to [my profile on stickertrade](https://stickertrade.ca/profile/nint8835).

## Running

By default, Sticker Trade writes are stubbed out. The script still reads from
Notion and Sticker Trade, but logs each sticker it would upload instead of
writing to Sticker Trade.

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

Required for Sticker Trade reads and writes:

- `STICKERTRADE_API_TOKEN`

Optional for Sticker Trade:

- `STICKERTRADE_MODE` - defaults to `mock`; set to `live` to create stickers

- `STICKERTRADE_API_BASE_URL` - defaults to `https://stickertrade.ca/api`

Create a Sticker Trade API token from `/account/profile` in Sticker Trade. Live
mode sends it as `Authorization: Bearer ...` and uploads stickers to
`POST /api/stickers`.
