/**
 * Cloudflare Pages Function middleware for time-travel routing.
 *
 * When a request includes ?t=YYYY-MM-DD, this middleware:
 * 1. Reads the milestones manifest from R2
 * 2. Finds the most recent milestone <= the requested date
 * 3. Serves assets from that snapshot in R2
 * 4. Injects a banner indicating time-travel mode
 *
 * Requests without ?t= pass through to the live site.
 */

interface Env {
  SNAPSHOTS: R2Bucket;
}

interface Milestone {
  tag: string;
  date: string;
  label: string;
  description?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const timeParam = url.searchParams.get("t");

  // No time-travel requested, pass through to live site
  if (!timeParam) {
    return context.next();
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(timeParam)) {
    return new Response("Invalid date format. Use YYYY-MM-DD.", { status: 400 });
  }

  const requestedDate = new Date(timeParam);
  if (isNaN(requestedDate.valueOf())) {
    return new Response("Invalid date.", { status: 400 });
  }

  try {
    // Read the manifest from R2
    const manifestObject = await context.env.SNAPSHOTS.get("manifest.json");
    if (!manifestObject) {
      // No snapshots exist yet, fall back to live site
      return context.next();
    }

    const manifest: Milestone[] = await manifestObject.json();
    if (!manifest.length) {
      return context.next();
    }

    // Find the most recent milestone <= requested date
    const eligibleMilestones = manifest
      .filter((m) => new Date(m.date) <= requestedDate)
      .sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());

    if (!eligibleMilestones.length) {
      return new Response(
        `No snapshot available for ${timeParam}. The earliest snapshot is from ${manifest[manifest.length - 1]?.date}.`,
        { status: 404 }
      );
    }

    const milestone = eligibleMilestones[0];
    const snapshotPrefix = `snapshots/${milestone.tag}/`;

    // Determine the asset path
    let assetPath = url.pathname;
    if (assetPath === "/" || assetPath === "") {
      assetPath = "/index.html";
    } else if (!assetPath.includes(".")) {
      // Try adding .html for clean URLs
      assetPath = assetPath.endsWith("/")
        ? `${assetPath}index.html`
        : `${assetPath}.html`;
    }

    // Fetch from R2
    const objectKey = `${snapshotPrefix}${assetPath.slice(1)}`;
    const object = await context.env.SNAPSHOTS.get(objectKey);

    if (!object) {
      // Try index.html for directory paths
      const fallbackKey = `${snapshotPrefix}${assetPath.slice(1)}/index.html`;
      const fallbackObject = await context.env.SNAPSHOTS.get(fallbackKey);

      if (!fallbackObject) {
        return new Response(`Page not found in snapshot ${milestone.tag}`, { status: 404 });
      }

      return serveSnapshotResponse(fallbackObject, milestone, url);
    }

    return serveSnapshotResponse(object, milestone, url);
  } catch (error) {
    console.error("Time-travel error:", error);
    // On error, fall back to live site
    return context.next();
  }
};

async function serveSnapshotResponse(
  object: R2ObjectBody,
  milestone: Milestone,
  url: URL
): Promise<Response> {
  const contentType = getContentType(url.pathname);
  const body = await object.arrayBuffer();

  // For HTML pages, inject the time-travel banner
  if (contentType === "text/html") {
    const html = new TextDecoder().decode(body);
    const isFrench = url.pathname.startsWith("/fr/") || url.pathname === "/fr";
    const bannerText = isFrench
      ? `Vous consultez ce site tel qu'il était le <strong>${milestone.date}</strong> · ${milestone.label}`
      : `You are viewing this site as it was on <strong>${milestone.date}</strong> · ${milestone.label}`;
    const backText = isFrench ? "← Retour au présent" : "← Back to present";
    const banner = `
      <div class="time-travel-banner" style="background:#fffbeb;border-bottom:1px solid #fcd34d;padding:8px 16px;text-align:center;font-family:system-ui,sans-serif;font-size:14px;">
        ${bannerText}
        <a href="${url.pathname}" style="margin-left:16px;">${backText}</a>
      </div>
    `;

    // Inject after <body> tag
    const modifiedHtml = html.replace(/<body([^>]*)>/, `<body$1>${banner}`);

    return new Response(modifiedHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Snapshot-Tag": milestone.tag,
        "X-Snapshot-Date": milestone.date,
      },
    });
  }

  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "X-Snapshot-Tag": milestone.tag,
      "X-Snapshot-Date": milestone.date,
    },
  });
}

function getContentType(pathname: string): string {
  const ext = pathname.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    xml: "application/xml",
    txt: "text/plain",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}
