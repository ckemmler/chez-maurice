import { Hono } from "hono";
import { requireApiKey } from "../../middleware/apiKey";
import books from "./books";
import chapters from "./chapters";
import summaries from "./summaries";
import actions from "./actions";
import bookmarks from "./bookmarks";
import highlights from "./highlights";
import add from "./add";

const calibre = new Hono();

// An install without Calibre's binaries — the Linux container does not ship
// them — says so on the one route that runs one: `/add` spawns `calibredb`.
// Everything else reads metadata.db as plain SQLite and the artifact files,
// and extraction and summaries run in this process (services/bookProcessing.ts),
// so they stay open. A hosted household adds books through Calibre-Web.
// Until 15 October 2026 the flag closed every route, which is why no hosted
// household could read or summarize a book.
if (process.env.MAURICE_CALIBRE_DISABLED) {
  const noCalibre = (c: any) =>
    c.json(
      { error: "Adding books needs Calibre, which this instance does not have: add them through the library page (/calibre)." },
      503,
    );
  calibre.all("/add", noCalibre);
  calibre.all("/add/*", noCalibre);
}

// Read-only routes are public (site is behind Cloudflare Access)
calibre.route("/books", books);
calibre.route("/books", chapters);
calibre.route("/books", summaries);
calibre.route("/books", actions);
calibre.route("/books", bookmarks);
calibre.route("/books", highlights);
calibre.route("/add", add);

export default calibre;
