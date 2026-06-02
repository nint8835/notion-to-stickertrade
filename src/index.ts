import { Client, isFullPage } from "@notionhq/client";
import type {
  PageObjectResponse,
  PartialPageObjectResponse,
  QueryDataSourceResponse,
} from "@notionhq/client";
import dotenv from "dotenv";
import cliProgress from "cli-progress";
import { randomUUID } from "crypto";

dotenv.config();

type NotionStickerInfo = {
  title: string;
  count: number;
  excluded: boolean;
  imageUrl: string | null;
};

type StickerTradeMode = "mock" | "live";

const stickerTradeMode: StickerTradeMode =
  process.env.STICKERTRADE_MODE === "live" ? "live" : "mock";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createNotionClient(): Client {
  return new Client({
    auth: requiredEnv("NOTION_TOKEN"),
  });
}

function isNotionPage(
  result: QueryDataSourceResponse["results"][number]
): result is PageObjectResponse {
  return result.object === "page" && isFullPage(result);
}

async function getNotionDataSourceId(notion: Client): Promise<string> {
  const configuredDataSourceId = process.env.NOTION_DATA_SOURCE_ID;
  if (configuredDataSourceId) {
    return configuredDataSourceId;
  }

  const database = await notion.databases.retrieve({
    database_id: requiredEnv("NOTION_DATABASE_ID"),
  });

  if (!("data_sources" in database)) {
    throw new Error("Notion database response did not include data sources");
  }

  const dataSourceId = database.data_sources[0]?.id;
  if (!dataSourceId) {
    throw new Error("Notion database does not have any data sources");
  }

  return dataSourceId;
}

function getImageUrl(image: unknown): string | null {
  if (
    typeof image === "object" &&
    image !== null &&
    "type" in image &&
    image.type === "file" &&
    "file" in image &&
    typeof image.file === "object" &&
    image.file !== null &&
    "url" in image.file &&
    typeof image.file.url === "string"
  ) {
    return image.file.url;
  }

  if (
    typeof image === "object" &&
    image !== null &&
    "type" in image &&
    image.type === "external" &&
    "external" in image &&
    typeof image.external === "object" &&
    image.external !== null &&
    "url" in image.external &&
    typeof image.external.url === "string"
  ) {
    return image.external.url;
  }

  return null;
}

type PageProperty = PageObjectResponse["properties"][string];

function matchesPropertyId(actual: string, expected: string): boolean {
  if (actual === expected) {
    return true;
  }

  try {
    return actual === decodeURIComponent(expected);
  } catch {
    return false;
  }
}

function findPropertyById(page: PageObjectResponse, propertyId: string) {
  return Object.values(page.properties).find((property) =>
    matchesPropertyId(property.id, propertyId)
  );
}

function getTitle(page: PageObjectResponse): string {
  const titleProperty = Object.values(page.properties).find(
    (property): property is PageProperty & { type: "title" } =>
      property.type === "title"
  );
  if (!titleProperty) {
    throw new Error(`Page ${page.id} does not have a title property`);
  }

  return titleProperty.title.map((text) => text.plain_text).join("");
}

function getCount(page: PageObjectResponse): number {
  const countProperty = findPropertyById(
    page,
    requiredEnv("NOTION_COUNT_PROPERTY_ID")
  );
  if (!countProperty || countProperty.type !== "number") {
    throw new Error(`Page ${page.id} count property is not a number`);
  }
  if (countProperty.number === null) {
    throw new Error(`Page ${page.id} count property is empty`);
  }

  return countProperty.number;
}

function getExcluded(page: PageObjectResponse): boolean {
  const excludedProperty = findPropertyById(
    page,
    requiredEnv("NOTION_EXCLUDE_PROPERTY_ID")
  );
  if (!excludedProperty || excludedProperty.type !== "checkbox") {
    throw new Error(`Page ${page.id} exclude property is not a checkbox`);
  }

  return excludedProperty.checkbox;
}

async function getNotionStickerInfo(
  notion: Client,
  page: PageObjectResponse,
  stickerTradeStickers: Set<string>,
  progressBar: cliProgress.MultiBar
): Promise<NotionStickerInfo | null> {
  const title = getTitle(page);

  if (stickerTradeStickers.has(title)) {
    progressBar.log(`Skipping ${title} because it's already in stickertrade\n`);
    return null;
  }

  if (title.length > 60) {
    progressBar.log(`Skipping ${title} because its title is over 60 chars\n`);
    return null;
  }

  const count = getCount(page);

  if (count === 0) {
    progressBar.log(`Skipping ${title} because it has no stickers remaining\n`);
    return null;
  }

  const excluded = getExcluded(page);

  if (excluded) {
    progressBar.log(`Skipping ${title} because it's excluded\n`);
    return null;
  }

  const blocks = await notion.blocks.children.list({
    block_id: page.id,
  });
  const imageBlock = blocks.results[0];
  if (!("type" in imageBlock)) {
    throw new Error("first block is a partial");
  }
  if (imageBlock.type !== "image") {
    throw new Error("first block is not an image");
  }

  return {
    title,
    count,
    excluded,
    imageUrl: getImageUrl(imageBlock.image),
  };
}

async function listNotionStickers(
  stickerTradeStickers: Set<string>
): Promise<NotionStickerInfo[]> {
  const notion = createNotionClient();
  const dataSourceId = await getNotionDataSourceId(notion);
  const stickerPages: PageObjectResponse[] = [];

  let response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    result_type: "page",
  });
  while (response.results.length > 0) {
    stickerPages.push(...response.results.filter(isNotionPage));
    if (response.has_more) {
      response = await notion.dataSources.query({
        data_source_id: dataSourceId,
        result_type: "page",
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
      notion,
      dbPage,
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
  if (stickerTradeMode === "mock") {
    console.log(
      "Sticker Trade is running in mock mode; treating the remote sticker list as empty."
    );
    return new Set();
  }

  const stickerResp = await fetch(
    `https://stickertrade.ca/profile/${requiredEnv(
      "STICKERTRADE_USERNAME"
    )}?_data=routes%2Fprofile%2F%24username`
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
  if (stickerTradeMode === "mock") {
    console.log(
      `[mock] Would create sticker "${info.title}"${
        info.imageUrl ? "" : " (no image URL available)"
      }`
    );
    return;
  }

  if (!info.imageUrl) {
    throw new Error(`Sticker ${info.title} does not have a usable image URL`);
  }

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
        Cookie: `RJ_session=${requiredEnv("STICKERTRADE_COOKIE")}`,
      },
      body: formData,
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to create sticker: ${await resp.text()}`);
  }
}

async function main() {
  console.log(`Sticker Trade mode: ${stickerTradeMode}`);
  console.log("Fetching current stickers from Sticker Trade...");
  const stickerTradeStickers = await listStickerTradeStickers();

  console.log("Fetching sticker details from Notion...");
  const notionStickers = await listNotionStickers(stickerTradeStickers);

  if (notionStickers.length === 0) {
    console.log("No stickers to add");
    return;
  }

  console.log("Creating stickers on Sticker Trade...");
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
