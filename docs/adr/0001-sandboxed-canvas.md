# Keep the canvas in a sandboxed iframe

The host can read Zotero data, save notes and call model endpoints with stored credentials. The canvas shows model-generated text and sends typed requests through a dedicated message port.

The iframe has an opaque origin. Gecko blocks separate `chrome://` scripts and styles under that origin. The production build embeds code, styles and fonts in one packaged document, with a script hash and a policy that disables network requests. The iframe allows form events for model settings, questions and library search. The document policy blocks form navigation. The privileged host checks the document URL and readiness before transferring a port. The canvas matches the message to a random token in its URL fragment because Gecko can omit the privileged sender. The dev server runs the same UI with a mock host.
