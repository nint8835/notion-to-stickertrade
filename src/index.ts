import { Client, isFullPage } from "@notionhq/client";
import type {
  ImageBlockObjectResponse,
  PageObjectResponse,
  QueryDataSourceResponse,
} from "@notionhq/client";
import dotenv from "dotenv";
import cliProgress from "cli-progress";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";

dotenv.config();

const execFileAsync = promisify(execFile);

type NotionStickerInfo = {
  title: string;
  url: string;
};

type NotionStickerPlan = {
  stickersToCreate: NotionStickerInfo[];
  desiredStickerNames: Set<string>;
};

type StickerTradeMode = "mock" | "live";

const stickerTradeMode: StickerTradeMode =
  process.env.STICKERTRADE_MODE === "live" ? "live" : "mock";
const notionVersion = "2026-03-11";
const defaultStickerTradeApiBaseUrl = "https://stickertrade.ca/api";
const maxStickerTradeImageBytes = 10 * 1024 * 1024;
const stickerImageMaxEdge = 1024;

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
    notionVersion,
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

type ImageMedia = ImageBlockObjectResponse["image"];
type UrlMedia = Extract<ImageMedia, { type: "file" | "external" }>;

function isUrlMedia(media: ImageMedia): media is UrlMedia {
  return media.type === "file" || media.type === "external";
}

function getMediaUrl(media: ImageMedia): string | null {
  if (!isUrlMedia(media)) {
    return null;
  }

  if (media.type === "file") {
    return media.file.url;
  }

  return media.external.url;
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

async function getBlockImageUrl(notion: Client, page: PageObjectResponse) {
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

  const imageUrl = getMediaUrl(imageBlock.image);
  if (!imageUrl) {
    throw new Error(
      `Image block for page ${page.id} did not include a file or external URL. ` +
        "Make sure NOTION_TOKEN is a Notion connection token with access to the database."
    );
  }

  return imageUrl;
}

async function getNotionStickerInfo(
  notion: Client,
  page: PageObjectResponse,
  stickerTradeStickerNames: Set<string>,
  progressBar: cliProgress.MultiBar
): Promise<{
  stickerInfo: NotionStickerInfo | null;
  desiredName: string | null;
}> {
  const title = getTitle(page);

  if (title.length > 60) {
    progressBar.log(`Skipping ${title} because its title is over 60 chars\n`);
    return { stickerInfo: null, desiredName: null };
  }

  const count = getCount(page);

  if (count === 0) {
    progressBar.log(`Skipping ${title} because it has no stickers remaining\n`);
    return { stickerInfo: null, desiredName: null };
  }

  const excluded = getExcluded(page);

  if (excluded) {
    progressBar.log(`Skipping ${title} because it's excluded\n`);
    return { stickerInfo: null, desiredName: null };
  }

  if (stickerTradeStickerNames.has(title)) {
    progressBar.log(`Skipping ${title} because it's already in stickertrade\n`);
    return { stickerInfo: null, desiredName: title };
  }

  const imageUrl = await getBlockImageUrl(notion, page);

  return {
    stickerInfo: {
      title,
      url: imageUrl,
    },
    desiredName: title,
  };
}

async function listNotionStickers(
  stickerTradeStickerNames: Set<string>
): Promise<NotionStickerPlan> {
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
  const desiredStickerNames = new Set<string>();
  for (const dbPage of stickerPages) {
    const { stickerInfo, desiredName } = await getNotionStickerInfo(
      notion,
      dbPage,
      stickerTradeStickerNames,
      progressBar
    );
    if (desiredName) {
      desiredStickerNames.add(desiredName);
    }
    if (stickerInfo) {
      stickerData.push(stickerInfo);
    }
    progressBarInst.increment();
  }
  progressBarInst.stop();
  progressBar.stop();
  return {
    stickersToCreate: stickerData,
    desiredStickerNames,
  };
}

type StickerTradeUser = {
  username: string;
  avatar_url: string | null;
};

type StickerTradeMeResp = {
  user: StickerTradeUser & {
    id: string;
    role: string;
    created_at: number;
  };
};

type StickerTradeUserStickersResp = {
  user: StickerTradeUser;
  stickers: StickerTradeSticker[];
};

type StickerTradeErrorResp = {
  error?: string;
  issues?: unknown;
};

type StickerTradeSticker = {
  id: string;
  name: string;
  image_url: string;
  owner: StickerTradeUser | null;
  created_at: number;
  updated_at: number;
};

function getStickerTradeApiBaseUrl(): string {
  return (
    process.env.STICKERTRADE_API_BASE_URL ?? defaultStickerTradeApiBaseUrl
  ).replace(/\/$/, "");
}

function getStickerTradeAuthHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${requiredEnv("STICKERTRADE_API_TOKEN")}`,
  };
}

async function getStickerTradeErrorMessage(resp: Response): Promise<string> {
  const contentType = resp.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await resp.json()) as StickerTradeErrorResp;
    return body.error ?? JSON.stringify(body);
  }

  return await resp.text();
}

async function getStickerTradeCurrentUser(): Promise<StickerTradeUser> {
  const resp = await fetch(`${getStickerTradeApiBaseUrl()}/me`, {
    headers: getStickerTradeAuthHeaders(),
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch Sticker Trade current user: ${await getStickerTradeErrorMessage(
        resp
      )}`
    );
  }

  const data = (await resp.json()) as StickerTradeMeResp;
  return data.user;
}

async function listStickerTradeStickers(): Promise<StickerTradeSticker[]> {
  const currentUser = await getStickerTradeCurrentUser();
  const username = encodeURIComponent(currentUser.username);
  const stickerResp = await fetch(
    `${getStickerTradeApiBaseUrl()}/users/${username}/stickers`
  );
  if (!stickerResp.ok) {
    throw new Error(
      `Failed to list stickers: ${await getStickerTradeErrorMessage(
        stickerResp
      )}`
    );
  }

  const stickerData =
    (await stickerResp.json()) as StickerTradeUserStickersResp;

  return stickerData.stickers;
}

type StickerTradeImageUpload = {
  blob: Blob;
  filename: string;
};

function isUnsupportedHeifCompressionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "heif: Error while loading plugin: Support for this compression format has not been built in"
    )
  );
}

async function convertHeicToPngWithSips(
  sourceBuffer: Buffer,
  title: string
): Promise<Buffer> {
  if (process.platform !== "darwin") {
    throw new Error(
      `Unable to decode the HEIC image for ${title}: the sips fallback is only available on macOS.`
    );
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "notion-sticker-"));
  const inputPath = join(tempDirectory, "source.heic");
  const outputPath = join(tempDirectory, "source.png");

  try {
    await writeFile(inputPath, sourceBuffer);
    await execFileAsync("/usr/bin/sips", [
      "-s",
      "format",
      "png",
      inputPath,
      "--out",
      outputPath,
    ]);
    return await readFile(outputPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to convert the HEIC image for ${title}: ${message}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function optimizeStickerTradeImage(
  sourceBuffer: Buffer
): Promise<{ buffer: Buffer | null; smallestSize: number }> {
  const qualities = [82, 72, 62, 52];
  let smallestSize = sourceBuffer.byteLength;

  for (const quality of qualities) {
    const optimized = await sharp(sourceBuffer)
      .rotate()
      .resize(stickerImageMaxEdge, stickerImageMaxEdge, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality, effort: 6 })
      .toBuffer();

    smallestSize = optimized.byteLength;
    if (smallestSize <= maxStickerTradeImageBytes) {
      return { buffer: optimized, smallestSize };
    }
  }

  return { buffer: null, smallestSize };
}

async function createStickerTradeImageUpload(
  info: NotionStickerInfo
): Promise<StickerTradeImageUpload> {
  const imageResp = await fetch(info.url);
  if (!imageResp.ok) {
    throw new Error(`Failed to fetch image for ${info.title}`);
  }

  const sourceBuffer = Buffer.from(await imageResp.arrayBuffer());
  let result: Awaited<ReturnType<typeof optimizeStickerTradeImage>>;

  try {
    result = await optimizeStickerTradeImage(sourceBuffer);
  } catch (error) {
    if (!isUnsupportedHeifCompressionError(error)) {
      throw error;
    }

    const converted = await convertHeicToPngWithSips(sourceBuffer, info.title);
    result = await optimizeStickerTradeImage(converted);
  }

  if (result.buffer) {
    return {
      blob: new Blob([new Uint8Array(result.buffer)], {
        type: "image/webp",
      }),
      filename: `${randomUUID()}.webp`,
    };
  }

  throw new Error(
    `Unable to fit image for ${info.title} under ${
      maxStickerTradeImageBytes / 1024 / 1024
    } MB. Smallest generated image was ${(
      result.smallestSize /
      1024 /
      1024
    ).toFixed(2)} MB.`
  );
}

async function createStickerTradeSticker(
  info: NotionStickerInfo
): Promise<void> {
  if (stickerTradeMode === "mock") {
    console.log(`[mock] Would create sticker "${info.title}"`);
    return;
  }

  const imageUpload = await createStickerTradeImageUpload(info);

  const formData = new FormData();
  formData.append("name", info.title);
  formData.append("image", imageUpload.blob, imageUpload.filename);

  const resp = await fetch(`${getStickerTradeApiBaseUrl()}/stickers`, {
    method: "POST",
    headers: getStickerTradeAuthHeaders(),
    body: formData,
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to create sticker: ${await getStickerTradeErrorMessage(resp)}`
    );
  }
}

async function deleteStickerTradeSticker(
  sticker: StickerTradeSticker
): Promise<void> {
  if (stickerTradeMode === "mock") {
    console.log(
      `[mock] Would delete sticker "${sticker.name}" (${sticker.id})`
    );
    return;
  }

  const resp = await fetch(
    `${getStickerTradeApiBaseUrl()}/stickers/${encodeURIComponent(sticker.id)}`,
    {
      method: "DELETE",
      headers: getStickerTradeAuthHeaders(),
    }
  );
  if (!resp.ok) {
    throw new Error(
      `Failed to delete sticker "${
        sticker.name
      }": ${await getStickerTradeErrorMessage(resp)}`
    );
  }
}

async function main() {
  console.log(`Sticker Trade mode: ${stickerTradeMode}`);
  console.log("Fetching current stickers from Sticker Trade...");
  const stickerTradeStickers = await listStickerTradeStickers();
  const stickerTradeStickerNames = new Set(
    stickerTradeStickers.map((sticker) => sticker.name)
  );

  console.log("Fetching sticker details from Notion...");
  const notionStickerPlan = await listNotionStickers(stickerTradeStickerNames);
  const notionStickers = notionStickerPlan.stickersToCreate;
  const stickerTradeStickersToDelete = stickerTradeStickers.filter(
    (sticker) => !notionStickerPlan.desiredStickerNames.has(sticker.name)
  );

  if (
    notionStickers.length === 0 &&
    stickerTradeStickersToDelete.length === 0
  ) {
    console.log("No sticker changes");
    return;
  }

  const sortedNotionStickers = [...notionStickers].sort((a, b) =>
    a.title.localeCompare(b.title)
  );
  const sortedStickerTradeStickersToDelete = [
    ...stickerTradeStickersToDelete,
  ].sort((a, b) => a.name.localeCompare(b.name));

  if (stickerTradeMode === "mock") {
    console.log("Mock mode: logging sticker changes...");
  } else {
    console.log("Syncing stickers on Sticker Trade...");
  }

  if (sortedStickerTradeStickersToDelete.length > 0) {
    console.log("Deleting stickers from Sticker Trade...");
    const progressBar = new cliProgress.SingleBar(
      {},
      cliProgress.Presets.shades_classic
    );
    progressBar.start(sortedStickerTradeStickersToDelete.length, 0);

    for (const sticker of sortedStickerTradeStickersToDelete) {
      await deleteStickerTradeSticker(sticker);
      progressBar.increment();
    }
    progressBar.stop();
  }

  if (sortedNotionStickers.length > 0) {
    console.log("Creating stickers on Sticker Trade...");
    const progressBar = new cliProgress.SingleBar(
      {},
      cliProgress.Presets.shades_classic
    );
    progressBar.start(sortedNotionStickers.length, 0);

    for (const sticker of sortedNotionStickers) {
      await createStickerTradeSticker(sticker);
      progressBar.increment();
    }
    progressBar.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
