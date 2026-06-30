import type { AstroIntegration } from "astro";
import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes, createCipheriv, pbkdf2Sync } from "node:crypto";
import { glob } from "node:fs/promises";

const PBKDF2_ITERATIONS = 600_000;

export default function encryptPrivate(): AstroIntegration {
  return {
    name: "encrypt-private",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const password = process.env.PRIVATE_CONTENT_PASSWORD;
        if (!password) {
          logger.warn(
            "PRIVATE_CONTENT_PASSWORD not set — private pages left unencrypted"
          );
          return;
        }

        const distDir = fileURLToPath(dir);
        const noteDirs = [
          join(distDir, "notes"),
          join(distDir, "fr", "notes"),
        ];

        let count = 0;

        for (const noteDir of noteDirs) {
          try {
            await access(noteDir);
          } catch {
            continue; // directory doesn't exist
          }

          for await (const entry of glob("**/*.html", { cwd: noteDir })) {
            const filePath = join(noteDir, entry);
            const html = await readFile(filePath, "utf-8");
            if (!html.includes("data-private")) continue;
            const encrypted = encryptPage(html, password);
            await writeFile(filePath, encrypted, "utf-8");
            count++;
          }
        }

        logger.info(`Encrypted ${count} private page(s)`);
      },
    },
  };
}

function encryptPage(html: string, password: string): string {
  // Extract article inner content
  const articleMatch = html.match(
    /(<article[^>]*>)([\s\S]*?)(<\/article>)/
  );
  if (!articleMatch) return html;

  const [, articleOpen, articleContent, articleClose] = articleMatch;

  // Encrypt
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(articleContent, "utf8"),
    cipher.final(),
    cipher.getAuthTag(), // 16 bytes, appended for Web Crypto compatibility
  ]);

  const saltB64 = salt.toString("base64");
  const ivB64 = iv.toString("base64");
  const payloadB64 = encrypted.toString("base64");

  // Replace <title> with generic label
  let result = html.replace(
    /<title>[^<]*<\/title>/,
    "<title>Private Note</title>"
  );

  // Remove description meta tag
  result = result.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    ""
  );

  // Replace article contents with encrypted payload + decryption UI
  const replacement = `${articleOpen}
${buildEncryptedUI(saltB64, ivB64, payloadB64)}
${articleClose}`;

  result = result.replace(
    /(<article[^>]*>)([\s\S]*?)(<\/article>)/,
    replacement
  );

  return result;
}

function buildEncryptedUI(
  salt: string,
  iv: string,
  payload: string
): string {
  return `<script type="application/encrypted" data-salt="${salt}" data-iv="${iv}">${payload}</script>

<div id="ep-prompt" style="max-width:65ch">
  <style>
    #ep-prompt {
      margin-top: var(--spacing-xl, 2rem);
    }
    #ep-prompt h2 {
      font-size: 1.5rem;
      margin-bottom: var(--spacing-md, 1rem);
    }
    #ep-form {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    #ep-password {
      font-family: inherit;
      font-size: 1rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--color-border, #ccc);
      border-radius: 6px;
      background: var(--color-bg, #fff);
      color: var(--color-text, #000);
      flex: 1;
      max-width: 20rem;
    }
    #ep-password:focus {
      outline: 2px solid var(--color-link, #3b82f6);
      outline-offset: 1px;
    }
    #ep-submit {
      font-family: inherit;
      font-size: 1rem;
      padding: 0.5rem 1.25rem;
      border: none;
      border-radius: 6px;
      background: var(--color-link, #3b82f6);
      color: #fff;
      cursor: pointer;
      white-space: nowrap;
    }
    #ep-submit:hover { opacity: 0.9; }
    #ep-error {
      color: #ef4444;
      margin-top: 0.5rem;
      font-size: 0.9rem;
      display: none;
    }
  </style>
  <h2>This note is encrypted</h2>
  <form id="ep-form">
    <input type="password" id="ep-password" placeholder="Password" autocomplete="off" autofocus />
    <button type="submit" id="ep-submit">Unlock</button>
  </form>
  <p id="ep-error">Wrong password. Try again.</p>
</div>

<noscript><p>JavaScript is required to decrypt this note.</p></noscript>

<script>
(function() {
  var ITERATIONS = ${PBKDF2_ITERATIONS};
  var el = document.querySelector('script[type="application/encrypted"]');
  if (!el) return;
  var salt = Uint8Array.from(atob(el.dataset.salt), function(c) { return c.charCodeAt(0); });
  var iv = Uint8Array.from(atob(el.dataset.iv), function(c) { return c.charCodeAt(0); });
  var ciphertext = Uint8Array.from(atob(el.textContent), function(c) { return c.charCodeAt(0); });

  var article = el.closest('article');
  var prompt = document.getElementById('ep-prompt');
  var form = document.getElementById('ep-form');
  var input = document.getElementById('ep-password');
  var error = document.getElementById('ep-error');

  function deriveKey(password, salt) {
    return crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    ).then(function(base) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']
      );
    });
  }

  function decrypt(key) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv }, key, ciphertext
    ).then(function(buf) {
      return new TextDecoder().decode(buf);
    });
  }

  function reveal(html) {
    article.innerHTML = html;
    // Restore page title from decrypted h1
    var h1 = article.querySelector('h1');
    if (h1) document.title = h1.textContent + ' \\u00b7 ' + document.title.split('\\u00b7').pop().trim();
  }

  function exportKey(key) {
    return crypto.subtle.exportKey('jwk', key);
  }

  function importKey(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  // Try cached key from sessionStorage
  var cached = sessionStorage.getItem('ep-key');
  if (cached) {
    importKey(JSON.parse(cached)).then(function(key) {
      return decrypt(key).then(reveal);
    }).catch(function() {
      sessionStorage.removeItem('ep-key');
    });
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    error.style.display = 'none';
    var pw = input.value;
    if (!pw) return;

    deriveKey(pw, salt).then(function(key) {
      return decrypt(key).then(function(html) {
        return exportKey(key).then(function(jwk) {
          sessionStorage.setItem('ep-key', JSON.stringify(jwk));
          reveal(html);
        });
      });
    }).catch(function() {
      error.style.display = 'block';
      input.value = '';
      input.focus();
    });
  });
})();
</script>`;
}
