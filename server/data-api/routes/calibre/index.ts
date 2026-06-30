import { Hono } from "hono";
import { requireApiKey } from "../../middleware/apiKey";
import books from "./books";
import chapters from "./chapters";
import summaries from "./summaries";
import actions from "./actions";
import bookmarks from "./bookmarks";
import add from "./add";

const calibre = new Hono();

// Read-only routes are public (site is behind Cloudflare Access)
calibre.route("/books", books);
calibre.route("/books", chapters);
calibre.route("/books", summaries);
calibre.route("/books", actions);
calibre.route("/books", bookmarks);
calibre.route("/add", add);

export default calibre;
