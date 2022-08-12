import { Client,  } from "@notionhq/client";
import { PageObjectResponse, PartialPageObjectResponse, TitlePropertyItemObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const notion = new Client({
    auth: process.env.NOTION_TOKEN,
  });

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

  console.log(stickerPages.length);
  
  for (const dbPage of stickerPages) {
    const titleResponse = await notion.pages.properties.retrieve({
      page_id: dbPage.id,
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
      page_id: dbPage.id,
      property_id: process.env.NOTION_COUNT_PROPERTY_ID!,
    });
    if (countResponse.type !== "number") {
      throw new Error("count is not a property item");
    }

    const title = titleObject.title.plain_text;
    const count = countResponse.number;
    console.log(`${title}: ${count}`);
  

    const blocks = await notion.blocks.children.list({
      block_id: dbPage.id,
    });
    const imageBlock = blocks.results[0];
    if (!("type" in imageBlock)) {
      throw new Error("first block is a partial");
    }
    if (imageBlock.type !== "image") {
      console.log(titleObject.title.plain_text);
      throw new Error("first block is not an image");
    }

    const image = imageBlock.image;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
