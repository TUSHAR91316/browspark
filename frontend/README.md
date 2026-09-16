# Browspark landing page

A standalone static site using HTML, CSS, and a small JavaScript module. It shares the extension's neutral dark palette and green accent. There is no frontend framework, hydration, runtime dependency, or external font request. Bun is used only for local serving and minifying the production JavaScript and CSS.

The page describes simultaneous Chrome and Brave extension profiles plus named Chrome, Brave, Firefox and Zen developer sessions. All browsers expose the same 43 tool names (22 browser, 21 developer); Firefox and Zen have documented capability exceptions. Their developer profiles are separate from the user's existing sessions. Keep this distinction in visible copy, metadata, and the illustrative preview.

## Develop

With Bun installed, from the repository root:

```sh
cd frontend
bun run dev
```

Open http://127.0.0.1:3000. Refresh after editing a file. To choose another port, run `PORT=3001 bun run dev`.

## Build and preview

```sh
bun run build
bun run preview
```

The build creates `frontend/dist/` with `index.html`, `robots.txt`, `sitemap.xml`, `setup.sh`, minified CSS and JavaScript, and local assets. Preview uses the same local address and supports the `PORT` environment variable.

Run `bun run test` to rebuild and smoke-test the production server, static asset references, path restrictions, metadata, and tool counts against the companion's registrations. The test uses an ephemeral local port and shuts its server down afterward.

## Deploy

Upload the contents of `frontend/dist/` to any static host. When configuring a host from the repository, set its working directory to `frontend`, its build command to `bun run build`, and its publish directory to `dist`. The deployed site does not need Bun or a server-side application. Enable compression on the host for HTML, CSS, JavaScript, and SVG files.

Edit `index.html` for content and links, `styles.css` for styling, and `main.js` for interactions. The preview is illustrative: shared-tab switches show Chrome and Brave, while the tool ticker also shows Firefox and Zen developer contexts. Its page commands use explicit companion tab IDs; keep sample arguments aligned with the live tool schemas. Keep the logos in `assets/`; their source credits are included alongside the assets.

## Search discovery

`index.html` includes the canonical URL, search and social metadata, and `WebSite` / `SoftwareApplication` JSON-LD. Keep the product description, visible content, and structured data consistent. The sitemap lists only the canonical homepage; the documentation subdomain manages its own sitemap. If the public domain changes, update `index.html`, `robots.txt`, and `sitemap.xml` together.

After deployment:

- Check that `/`, `/robots.txt`, and `/sitemap.xml` return HTTP 200 publicly, without login or browser challenges. Hosting or CDN rules must allow search crawlers, including Googlebot, Bingbot, and OpenAI's `OAI-SearchBot`; a robots allow rule cannot override a firewall block. [OpenAI crawler guidance](https://developers.openai.com/api/docs/bots).
- Verify the site in [Google Search Console](https://search.google.com/search-console) and [Bing Webmaster Tools](https://www.bing.com/webmasters/), submit `https://browspark.krishm.dev/sitemap.xml`, and inspect the homepage for indexing.
- Check structured data with the [Schema.org validator](https://validator.schema.org/) and monitor actual queries, impressions, and clicks. The software markup describes the project; it does not assert ratings or rich-result eligibility.

Metadata and crawl access help discovery; they cannot guarantee indexing, citations, or first-place rankings. Google applies ordinary SEO fundamentals to its AI search features and does not require special AI text files or schema. [Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features).

## Verification

Local production build, Lighthouse simulated mobile, September 12, 2026: 100 performance, 100 accessibility, 100 best practices, and 100 SEO. LCP was 1.51 seconds, total blocking time 0 ms, and transfer size 78.2 KiB across 11 local requests. These are local lab results; production hosting and network conditions affect performance. Reports are in the ignored `.reports/` folder.

Browser checks covered desktop, 390 px and 320 px layouts, preview switches and views, all six client configurations, copying, remembered selection, mobile navigation, and FAQ expansion.
