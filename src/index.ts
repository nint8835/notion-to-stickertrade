import { Client } from "@notionhq/client";
import {
  PageObjectResponse,
  PartialPageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import dotenv from "dotenv";
import cliProgress from "cli-progress";
import fetch, { FormData } from "node-fetch";
import { randomUUID } from "crypto";

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

  if (title.length > 60) {
    throw new Error(`Sticker ${title} has too long of title (> 60 chars)`);
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
  progressBarInst.stop();
  progressBar.stop();
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

async function createStickerTradeSticker(
  info: NotionStickerInfo
): Promise<void> {
  const imageResp = await fetch(info.imageUrl);
  const imageBlob = await imageResp.blob();

  const formData = new FormData();
  formData.append("name", info.title);
  formData.append("image", imageBlob, `${randomUUID()}.jpg`);

  const resp = await fetch(
    "https://stickertrade.ca/upload-sticker?_data=routes%2Fupload-sticker",
    {
      method: "POST",
      headers: {
        Cookie: `RJ_session=${process.env.STICKERTRADE_COOKIE!}`,
      },
      body: formData,
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to create sticker: ${await resp.text()}`);
  }
}

async function main() {
  console.log("Fetching current stickers from stickertrade...");
  const stickerTradeStickers = await listStickerTradeStickers();

  console.log("Fetching sticker details from Notion...");
  const notionStickers = await listNotionStickers(stickerTradeStickers);

  if (notionStickers.length === 0) {
    console.log("No stickers to add");
    return;
  }

  console.log("Creating stickers on stickertrade...");
  const progressBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic
  );
  progressBar.start(notionStickers.length, 0);

  for (const sticker of notionStickers) {
    await createStickerTradeSticker(sticker);
    progressBar.increment();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
