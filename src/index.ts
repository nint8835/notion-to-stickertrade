import { Client,  } from "@notionhq/client";
import { PageObjectResponse, PartialPageObjectResponse, TitlePropertyItemObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import dotenv from "dotenv";
import cliProgress from 'cli-progress';

dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

type StickerData = {
  title: string;
  count: number;
  excluded: boolean;
  imageUrl: string;
}

async function getNotionStickerInfo(pageId: string): Promise<StickerData> {
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

  const countResponse = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: process.env.NOTION_COUNT_PROPERTY_ID!,
  });
  if (countResponse.type !== "number") {
    throw new Error("count is not a number");
  }

  const excludeResponse = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: process.env.NOTION_EXCLUDE_PROPERTY_ID!,
  });
  if (excludeResponse.type !== "checkbox") {
    throw new Error("exclude is not a checkbox");
  }

  const blocks = await notion.blocks.children.list({
    block_id: pageId,
  });
  const imageBlock = blocks.results[0];
  if (!("type" in imageBlock)) {
    throw new Error("first block is a partial");
  }
  if (imageBlock.type !== "image") {
    console.log(titleObject.title.plain_text);
    throw new Error("first block is not an image");
  }
  if (imageBlock.image.type !== "file") {
    throw new Error("image is not file");
  }

  return {
    title: titleObject.title.plain_text,
    count: countResponse.number!,
    excluded: excludeResponse.checkbox,
    imageUrl: imageBlock.image.file.url,
  }
}

async function listNotionStickers(): Promise<StickerData[]> {
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

  console.log("Fetching sticker details from Notion...")
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(stickerPages.length, 0);

  const stickerData: StickerData[] = [];
  for (const dbPage of stickerPages) {
    stickerData.push(await getNotionStickerInfo(dbPage.id));
    progressBar.increment();
  }
  return stickerData;
}

async function main() {
  const notionStickers = await listNotionStickers();
  console.log(notionStickers)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
