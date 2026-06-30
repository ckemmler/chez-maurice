import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dataDir } from "../db";

const imagesDir = join(dataDir, "images");
mkdirSync(imagesDir, { recursive: true });

export { imagesDir };

export function saveUploadedImage(dataUri: string): { filename: string } {
  // Parse data URI: data:image/jpeg;base64,/9j/4AAQ...
  const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid image data URI");
  }
  const ext = match[1] === "png" ? "png" : "jpg";
  const base64Data = match[2]!;
  const buffer = Buffer.from(base64Data, "base64");
  const filename = `${crypto.randomUUID()}.${ext}`;
  writeFileSync(join(imagesDir, filename), buffer);
  return { filename };
}

export async function generateImage(
  prompt: string,
  falApiKey: string
): Promise<{ filename: string; localPath: string }> {
  // Submit request to FAL flux/schnell (synchronous endpoint)
  const response = await fetch(
    "https://fal.run/fal-ai/flux/schnell",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${falApiKey}`,
      },
      body: JSON.stringify({
        prompt,
        image_size: "square_hd",
        num_images: 1,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FAL API error ${response.status}: ${body}`);
  }

  const result = await response.json() as any;

  // FAL returns { images: [{ url, width, height, content_type }] }
  const imageUrl: string = result.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error(`FAL returned no image URL. Response: ${JSON.stringify(result)}`);
  }

  // Download the image
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download image: ${imageResponse.status}`);
  }

  const buffer = await imageResponse.arrayBuffer();
  const filename = `${crypto.randomUUID()}.png`;
  const localPath = join(imagesDir, filename);
  writeFileSync(localPath, Buffer.from(buffer));

  return { filename, localPath };
}

export async function editImage(
  imageDataUri: string,
  prompt: string,
  falApiKey: string
): Promise<{ filename: string }> {
  const response = await fetch(
    "https://fal.run/openai/gpt-image-2/edit",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${falApiKey}`,
      },
      body: JSON.stringify({
        image_urls: [imageDataUri],
        prompt,
        quality: "low",
        output_format: "png",
        image_size: "auto",
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FAL edit API error ${response.status}: ${body}`);
  }

  const result = (await response.json()) as any;

  const imageUrl: string = result.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error(
      `FAL edit returned no image URL. Response: ${JSON.stringify(result)}`
    );
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download edited image: ${imageResponse.status}`);
  }

  const buffer = await imageResponse.arrayBuffer();
  const filename = `${crypto.randomUUID()}.png`;
  writeFileSync(join(imagesDir, filename), Buffer.from(buffer));

  return { filename };
}

export function loadImageAsDataUri(filename: string): string {
  const filePath = join(imagesDir, filename);
  const data = readFileSync(filePath).toString("base64");
  const mediaType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mediaType};base64,${data}`;
}
