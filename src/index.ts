import { Client } from "@notionhq/client";
import {
  PageObjectResponse,
  PartialPageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import dotenv from "dotenv";
import cliProgress from "cli-progress";
import fetch from "node-fetch";

dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

type NotionStickerInfo = {
  title: string;
  count: number;
  excluded: boolean;
  imageUrl: string;
};

async function getNotionStickerInfo(
  pageId: string,
  stickerTradeStickers: Set<string>,
  progressBar: cliProgress.MultiBar
): Promise<NotionStickerInfo | null> {
  const titleResponse = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: "title",
  });
  if (titleResponse.type !== "property_item") {
    throw new Error("title is not a property item");
  }
  const titleObject = titleResponse.results[0];
  if (titleObject.type !== "title") {
    throw new Error("title is not a title");
  }
  const title = titleObject.title.plain_text;

  if (stickerTradeStickers.has(title)) {
    progressBar.log(`Skipping ${title} because it's already in stickertrade\n`);
    return null;
  }

  const countResponse = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: process.env.NOTION_COUNT_PROPERTY_ID!,
  });
  if (countResponse.type !== "number") {
    throw new Error("count is not a number");
  }
  const count = countResponse.number;

  if (count === 0) {
    progressBar.log(`Skipping ${title} because it has no stickers remaining\n`);
    return null;
  }

  const excludeResponse = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: process.env.NOTION_EXCLUDE_PROPERTY_ID!,
  });
  if (excludeResponse.type !== "checkbox") {
    throw new Error("exclude is not a checkbox");
  }
  const excluded = excludeResponse.checkbox;

  if (excluded) {
    progressBar.log(`Skipping ${title} because it's excluded\n`);
    return null;
  }

  const blocks = await notion.blocks.children.list({
    block_id: pageId,
  });
  const imageBlock = blocks.results[0];
  if (!("type" in imageBlock)) {
    throw new Error("first block is a partial");
  }
  if (imageBlock.type !== "image") {
    throw new Error("first block is not an image");
  }
  if (imageBlock.image.type !== "file") {
    throw new Error("image is not file");
  }

  return {
    title,
    count: count!,
    excluded,
    imageUrl: imageBlock.image.file.url,
  };
}

async function listNotionStickers(
  stickerTradeStickers: Set<string>
): Promise<NotionStickerInfo[]> {
  const stickerPages: (PageObjectResponse | PartialPageObjectResponse)[] = [];

  let response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID!,
  });
  while (response.results.length > 0) {
    stickerPages.push(...response.results);
    if (response.has_more) {
      response = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID!,
        start_cursor: response.next_cursor!,
      });
    } else {
      break;
    }
  }

  console.log("Fetching sticker details from Notion...");
  const progressBar = new cliProgress.MultiBar(
    {},
    cliProgress.Presets.shades_classic
  );
  const progressBarInst = progressBar.create(stickerPages.length, 0);

  const stickerData: NotionStickerInfo[] = [];
  for (const dbPage of stickerPages) {
    const stickerInfo = await getNotionStickerInfo(
      dbPage.id,
      stickerTradeStickers,
      progressBar
    );
    if (stickerInfo) {
      stickerData.push(stickerInfo);
    }
    progressBarInst.increment();
  }
  return stickerData;
}

type StickerTradeProfileResp = {
  username: string;
  avatarUrl: string | null;
  stickers: {
    id: string;
    name: string;
    imageUrl: string;
  }[];
};

async function listStickerTradeStickers(): Promise<Set<string>> {
  const stickerResp = await fetch(
    `https://stickertrade.ca/profile/${process.env
      .STICKERTRADE_USERNAME!}?_data=routes%2Fprofile%2F%24username`
  );
  const stickerData = (await stickerResp.json()) as StickerTradeProfileResp;

  const stickers: Set<string> = new Set();

  for (const sticker of stickerData.stickers) {
    stickers.add(sticker.name);
  }

  return stickers;
}

async function main() {
  const stickerTradeStickers = await listStickerTradeStickers();

  const notionStickers = await listNotionStickers(stickerTradeStickers);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
