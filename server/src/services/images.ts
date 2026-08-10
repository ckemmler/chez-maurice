import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import sharp from "sharp";
import { dataDir } from "../db";

const imagesDir = join(dataDir, "images");
mkdirSync(imagesDir, { recursive: true });

export { imagesDir };

// ── Upload sizing ───────────────────────────────────────────────
//
// Claude reads an image as a grid of 28x28-pixel patches and bills
// ceil(w/28) * ceil(h/28) visual tokens for it. Each model tier caps that:
// 1568 tokens at 1568px on the long edge (Sonnet 4.6, Haiku 4.5), 4784 at
// 2576px on the high-resolution tier (Opus 4.8 and later). Anything larger is
// downscaled by the API before it is read.
//
// So a 12-megapixel phone photo buys nothing on the standard tier — the API was
// going to shrink it to about this size regardless — while on the high-res tier
// it costs three times as much for detail that matters to dense documents and
// screenshots, not to the holiday photos this actually carries. Sizing to the
// standard tier's ceiling at upload is therefore free on two of the three models
// and cuts the third by ~3x. It also shrinks every later turn: an image sits in
// the conversation prefix and is re-sent whole on every request.
//
const PATCH = 28;
const MAX_LONG_EDGE = 1568;
const MAX_TOKENS = 1568;

/** Visual tokens an image of this size costs. */
function visualTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

/** Longest edge and token count both inside the tier ceiling, aspect preserved.
 *  Never enlarges: a small image is left exactly as it is.
 *
 *  A pixel budget alone isn't enough — each side is rounded *up* to a whole
 *  patch, so 1280x960 is 1.23 megapixels yet still bills 46x35 = 1610 tokens,
 *  over the cap. Step down until the rounded-up grid actually fits. */
function targetSize(width: number, height: number): { width: number; height: number } | null {
  let scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height));
  let w = Math.round(width * scale);
  let h = Math.round(height * scale);
  while (visualTokens(w, h) > MAX_TOKENS && scale > 0.05) {
    scale *= 0.98;
    w = Math.round(width * scale);
    h = Math.round(height * scale);
  }
  if (w >= width && h >= height) return null; // already inside the budget
  return { width: w, height: h };
}

export async function saveUploadedImage(dataUri: string): Promise<{ filename: string }> {
  // Parse data URI: data:image/jpeg;base64,/9j/4AAQ...
  const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid image data URI");
  }
  const ext = match[1] === "png" ? "png" : "jpg";
  const buffer = Buffer.from(match[2]!, "base64");
  const filename = `${crypto.randomUUID()}.${ext}`;
  const path = join(imagesDir, filename);

  try {
    const image = sharp(buffer, { failOn: "none" });
    const { width, height } = await image.metadata();
    const target = width && height ? targetSize(width, height) : null;
    if (!target) {
      writeFileSync(path, buffer); // small enough already — keep the bytes as sent
      return { filename };
    }
    // PNG stays PNG. A PNG upload is usually a screenshot or a document, where
    // JPEG's ringing around glyphs is exactly the artifact the vision guidance
    // warns about; re-encoding one to JPEG would trade legible text for a few
    // kilobytes. Photos are JPEG at quality 85 — one pass, since repeated lossy
    // passes compound.
    const resized = await (ext === "png"
      ? image.resize(target).png({ compressionLevel: 9 })
      : image.resize(target).jpeg({ quality: 85 })
    ).toBuffer();
    // The full-resolution upload is kept beside the served copy. Shrinking is
    // the point, but it is the user's photo: discarding the only high-resolution
    // version to save a few megabytes is not ours to do silently.
    writeFileSync(join(imagesDir, `${filename}.orig`), buffer);
    writeFileSync(path, resized);
  } catch {
    // Unreadable or exotic format — store what was sent rather than lose it.
    writeFileSync(path, buffer);
  }
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
