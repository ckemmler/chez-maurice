/**
 * An article read for a conversation, not kept.
 *
 * What the app's share sheet asks for when an article is shared with Maurice:
 * its text and enough of its metadata to show a card, through the same
 * extractor as a garden save — but nothing is written. Keeping the article is
 * Carnet's gesture; this one is "let's talk about it".
 */

import { ArticleRefusedError, extractArticleFromHtml, extractArticleFromUrl } from "./articleExtract";

/** The DOM a caller may hand over — the garden route's cap. */
export const MAX_SHARED_HTML_BYTES = 8 * 1024 * 1024;

export interface ArticleReadInput {
  url?: string;
  /** The page as the browser rendered it (Safari's share sheet). */
  html?: string;
}

export interface ArticleRead {
  url: string;
  title: string;
  site_name: string;
  author: string;
  published_at: string;
  lang: string;
  text: string;
  word_count: number;
}

export class ArticleReadError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 422) {
    super(message);
  }
}

export async function readSharedArticle(input: ArticleReadInput): Promise<ArticleRead> {
  const url = (input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new ArticleReadError("url must be an http(s) address", 400);
  const html = typeof input.html === "string" ? input.html : "";
  if (html.length > MAX_SHARED_HTML_BYTES) throw new ArticleReadError("html exceeds the size limit", 413);

  let article;
  try {
    // The rendered page when there is one: it is past the paywall the server's
    // own fetch would meet.
    article = html ? extractArticleFromHtml(url, html) : await extractArticleFromUrl(url);
  } catch (e) {
    if (e instanceof ArticleRefusedError) throw new ArticleReadError(e.message, 422);
    throw new ArticleReadError(`could not read the page: ${(e as Error).message}`, 422);
  }
  if (!article.content) throw new ArticleReadError("no article text found on the page", 422);

  return {
    url,
    title: article.title,
    site_name: article.site_name,
    author: article.author,
    published_at: article.published_at,
    lang: article.lang,
    text: article.content,
    word_count: article.word_count,
  };
}
