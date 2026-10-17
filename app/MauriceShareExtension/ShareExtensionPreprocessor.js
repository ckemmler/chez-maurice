/*
 * Runs inside the Safari page when you share it.
 *
 * Safari hands a share extension a URL and nothing else, so the server had to go
 * fetch the article itself — and a server-side fetch of Le Monde or the NYT
 * meets a paywall or a bot check and reads that instead. The page in your tab
 * is already past all of it. This hands over the DOM Safari has rendered, so
 * the server parses what you actually read.
 *
 * Declared by NSExtensionJavaScriptPreprocessingFile; the object assigned to
 * ExtensionPreprocessingJS is the contract Apple looks for.
 */

/*
 * A cap, not a limit of the bridge: the extension runs in a ~120 MB budget and
 * the server refuses anything past 8 MB. Above this we send no DOM at all and
 * let the server fetch the URL — the pre-extension behaviour, which still works
 * for everything that is not paywalled.
 */
var MAX_HTML = 6000000;

var MauricePreprocessor = function () {};

MauricePreprocessor.prototype = {
  run: function (args) {
    var html = "";
    try {
      html = document.documentElement.outerHTML || "";
      if (html.length > MAX_HTML) html = "";
    } catch (e) {
      html = "";
    }

    var selection = "";
    try {
      var s = window.getSelection();
      selection = s ? String(s).trim().slice(0, 2000) : "";
    } catch (e) {
      selection = "";
    }

    args.completionFunction({
      url: document.URL,
      title: document.title || "",
      html: html,
      selection: selection,
    });
  },

  // Nothing to write back into the page after the sheet closes.
  finalize: function (args) {},
};

var ExtensionPreprocessingJS = new MauricePreprocessor();
