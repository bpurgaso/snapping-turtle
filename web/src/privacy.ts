import './styles.css';

// The privacy policy page (E8) is server-rendered from web/content/privacy.md
// (server/src/html.ts, renderPrivacyPage) and has no behaviour of its own.
// This entry exists so the page can link the shared stylesheet through the
// Vite manifest like the other server-rendered pages; the server links only
// the CSS it yields.
