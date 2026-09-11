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

// An install that has no Calibre — the Linux container does not ship it — says
// so once, here. Without this every route below still answers 200 with an empty
// library, or spawns a binary that isn't there and surfaces the ENOENT as a 500
// with no explanation. A 503 naming the flag is the difference between "Maurice
// is broken" and "this instance doesn't read books".
if (process.env.MAURICE_CALIBRE_DISABLED) {
  calibre.all("/*", (c) =>
    c.json(
      { error: "Calibre is not available on this instance (MAURICE_CALIBRE_DISABLED)" },
      503,
    ),
  );
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
